// Command argus-sidecar is the per-machine daemon. It registers itself
// with the Argus server, supervises N agents (each one wrapping a CLI
// like claude-code, codex, cursor-agent), and persists its identity and
// agent set to ~/.config/argus/sidecar.json so a restart re-spawns
// agents instantly without waiting for a server reconcile.
//
// Subcommands:
//
//	(default)   run the daemon (requires `init` to have been run once)
//	init        write the on-disk cache (bus URL, server URL, machine
//	            name) — interactive at a TTY, flag-driven otherwise
//	update      self-update by fetching the latest release for this OS/arch
//	version     print the build version
//	help        show usage
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"github.com/kyley/argus/sidecar/internal/adapter"
	"github.com/kyley/argus/sidecar/internal/machine"
	"github.com/kyley/argus/sidecar/internal/updater"
)

// Version is injected at build time via -ldflags="-X main.Version=…".
// Untagged dev builds report "dev"; release builds report the git tag
// (e.g. "argus-sidecar-v0.1.0"). Used by `version`, `update`, and
// embedded into MachineRegisterEvent.sidecarVersion.
var Version = "dev"

func main() {
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case "init":
			runInit(os.Args[2:])
			return
		case "update":
			runUpdate(os.Args[2:])
			return
		case "version", "--version", "-v":
			fmt.Printf("argus-sidecar %s %s/%s\n", Version, runtime.GOOS, runtime.GOARCH)
			return
		case "help", "--help", "-h":
			printUsage()
			return
		}
	}
	runDaemon(os.Args[1:])
}

func printUsage() {
	fmt.Fprintf(os.Stderr, `argus-sidecar — Argus per-machine agent gateway

Usage:
  argus-sidecar [flags]            run the daemon (default)
  argus-sidecar init [flags]       write the on-disk cache (one-time setup)
  argus-sidecar update [flags]     download the latest release for this OS/arch
  argus-sidecar version            print the build version
  argus-sidecar help               this message

Run flags (default mode):
  -cache <path>      path to sidecar cache (default: $XDG_CONFIG_HOME/argus/sidecar.json)
  -list-adapters     print registered adapter types and exit

Init flags:
  -bus <url>         Redis URL the server is using (e.g. redis://default:pwd@host:6379)
  -server <url>      Argus server base URL (e.g. https://argus.example.com)
  -token <secret>    SIDECAR_LINK_TOKEN matching the server (optional)
  -name <string>     machine name shown in the dashboard (defaults to hostname)
  -cache <path>      override cache path
  -force             overwrite an existing cache (regenerates machineId)

Update flags:
  -repo <owner/repo> override the GitHub repo (default: %s)
  -prerelease        consider prerelease tags
  -force             reinstall even if already on the latest tag

  Set GITHUB_TOKEN in the environment to authenticate against private
  repos or raise the unauthenticated rate limit (60 req/h → 5000 req/h).
`, updater.DefaultRepo)
}

func runDaemon(args []string) {
	fs := flag.NewFlagSet("argus-sidecar", flag.ExitOnError)
	cachePath := fs.String("cache", "", "path to sidecar cache (default: $XDG_CONFIG_HOME/argus/sidecar.json)")
	listAdapters := fs.Bool("list-adapters", false, "print registered adapter types and exit")
	_ = fs.Parse(args)

	if *listAdapters {
		fmt.Println(strings.Join(adapter.Types(), "\n"))
		return
	}

	logger := log.New(os.Stderr, "[argus-sidecar] ", log.LstdFlags|log.Lmicroseconds)

	path, err := resolveCachePath(*cachePath)
	if err != nil {
		logger.Fatalf("resolve cache path: %v", err)
	}

	cache, err := machine.Load(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			logger.Fatalf("no cache at %s — run `argus-sidecar init` first", path)
		}
		logger.Fatalf("load cache: %v", err)
	}
	logger.Printf("config: machineId=%s name=%s bus=%s agents=%d cache=%s",
		cache.MachineID, cache.Name, redactBus(cache.Bus), len(cache.Agents), path)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sigs
		logger.Printf("received %s, shutting down", s)
		cancel()
	}()

	d := machine.New(path, cache, Version, logger)
	if err := d.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Fatalf("daemon: %v", err)
	}
	logger.Println("bye")
}

func runInit(args []string) {
	fs := flag.NewFlagSet("init", flag.ExitOnError)
	bus := fs.String("bus", "", "Redis URL (required)")
	server := fs.String("server", "", "Argus server base URL (required for terminal access)")
	token := fs.String("token", "", "SIDECAR_LINK_TOKEN matching the server")
	name := fs.String("name", "", "machine name (defaults to hostname)")
	cachePath := fs.String("cache", "", "override cache path")
	force := fs.Bool("force", false, "overwrite an existing cache")
	_ = fs.Parse(args)

	logger := log.New(os.Stderr, "[argus-sidecar init] ", log.LstdFlags)

	path, err := resolveCachePath(*cachePath)
	if err != nil {
		logger.Fatalf("resolve cache path: %v", err)
	}

	existing, _ := machine.Load(path)
	if existing != nil && !*force {
		logger.Fatalf("cache already exists at %s — pass --force to overwrite (this regenerates machineId)", path)
	}

	interactive := isStdinTTY()
	if !interactive && *bus == "" {
		logger.Fatal("`--bus` is required in non-interactive mode")
	}

	if interactive {
		reader := bufio.NewReader(os.Stdin)
		if *bus == "" {
			*bus = prompt(reader, "Redis URL (e.g. redis://default:pwd@host:6379)", "")
		}
		if *server == "" {
			*server = prompt(reader, "Argus server base URL (optional, blank = headless agents only)", "")
		}
		if *token == "" && *server != "" {
			*token = prompt(reader, "Sidecar link token (matches server SIDECAR_LINK_TOKEN; blank if server has none)", "")
		}
		defaultName := machine.DetectMachineName()
		if *name == "" {
			*name = prompt(reader, "Machine name", defaultName)
		}
	}

	if *bus == "" {
		logger.Fatal("bus URL is required")
	}
	if _, err := url.Parse(*bus); err != nil {
		logger.Fatalf("invalid bus URL: %v", err)
	}
	if *server != "" {
		if _, err := url.Parse(*server); err != nil {
			logger.Fatalf("invalid server URL: %v", err)
		}
	}
	if *name == "" {
		*name = machine.DetectMachineName()
	}

	cache := &machine.Cache{
		MachineID: machine.NewMachineID(),
		Name:      *name,
		Bus:       *bus,
		Server:    machine.ServerConfig{URL: *server, Token: *token},
		Agents:    nil,
	}
	if existing != nil && *force {
		// Preserve the agent set across re-init: the operator probably
		// wants a fresh server URL or rotated bus credentials, not to
		// nuke the (server-managed) agent definitions and risk an
		// out-of-sync sidecar↔server view until the next sync.
		cache.Agents = existing.Agents
	}

	if err := machine.Save(path, cache); err != nil {
		logger.Fatalf("save cache: %v", err)
	}
	fmt.Printf("argus-sidecar initialized at %s\n", path)
	fmt.Printf("  machineId: %s\n", cache.MachineID)
	fmt.Printf("  name:      %s\n", cache.Name)
	fmt.Printf("  bus:       %s\n", redactBus(cache.Bus))
	if cache.Server.URL != "" {
		fmt.Printf("  server:    %s\n", cache.Server.URL)
	}
	fmt.Printf("\nStart the daemon with: argus-sidecar\n")
}

func runUpdate(args []string) {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	repo := fs.String("repo", updater.DefaultRepo, "GitHub repo (owner/name)")
	prerelease := fs.Bool("prerelease", false, "consider prerelease tags")
	force := fs.Bool("force", false, "reinstall even if already on the latest tag")
	_ = fs.Parse(args)

	logger := log.New(os.Stderr, "[argus-sidecar update] ", log.LstdFlags)
	logger.Printf("current version: %s (%s/%s)", Version, runtime.GOOS, runtime.GOARCH)

	tag, err := updater.Update(context.Background(), updater.Options{
		Repo:              *repo,
		IncludePrerelease: *prerelease,
		CurrentVersion:    Version,
		Force:             *force,
		Logger:            logger,
	})
	if err != nil {
		logger.Fatalf("update failed: %v", err)
	}
	if tag == Version {
		return
	}
	fmt.Printf("argus-sidecar updated to %s\n", tag)
}

func resolveCachePath(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	return machine.DefaultPath()
}

// redactBus replaces any inline credentials in a Redis URL with "***"
// so log lines / init banners don't leak the password to whoever's
// watching the terminal. Best-effort: malformed URLs pass through.
func redactBus(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return raw
	}
	u.User = url.UserPassword(u.User.Username(), "***")
	return u.String()
}

func prompt(r *bufio.Reader, question, def string) string {
	if def != "" {
		fmt.Fprintf(os.Stderr, "%s [%s]: ", question, def)
	} else {
		fmt.Fprintf(os.Stderr, "%s: ", question)
	}
	line, err := r.ReadString('\n')
	if err != nil {
		return def
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return def
	}
	return line
}

func isStdinTTY() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}
