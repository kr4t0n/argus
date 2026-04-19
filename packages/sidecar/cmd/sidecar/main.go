package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"github.com/kyley/argus/sidecar/internal/adapter"
	"github.com/kyley/argus/sidecar/internal/config"
	"github.com/kyley/argus/sidecar/internal/lifecycle"
	"github.com/kyley/argus/sidecar/internal/updater"
)

// Version is injected at build time via -ldflags="-X main.Version=…".
// Untagged dev builds report "dev"; release builds report the git tag
// (e.g. "argus-sidecar-v0.1.0"). Used by the `version` subcommand and
// the "already up to date" check inside `update`.
var Version = "dev"

func main() {
	// Lightweight subcommand dispatch. We deliberately avoid pulling in a
	// full CLI framework — the surface is tiny and `argus-sidecar` is the
	// hot path, so startup cost matters. The default (no subcommand) keeps
	// the original "run the daemon" behavior so existing launchd/systemd
	// units don't need to change.
	if len(os.Args) >= 2 {
		switch os.Args[1] {
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
  argus-sidecar [flags]            run the sidecar (default)
  argus-sidecar update [flags]     download the latest release for this OS/arch
  argus-sidecar version            print the build version
  argus-sidecar help               this message

Run flags (default mode):
  -config <path>     path to sidecar.yaml (default: sidecar.yaml)
  -list-adapters     print registered adapter types and exit

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
	cfgPath := fs.String("config", "sidecar.yaml", "path to sidecar config")
	listAdapters := fs.Bool("list-adapters", false, "print registered adapter types and exit")
	_ = fs.Parse(args)

	if *listAdapters {
		fmt.Println(strings.Join(adapter.Types(), "\n"))
		return
	}

	logger := log.New(os.Stderr, "[argus-sidecar] ", log.LstdFlags|log.Lmicroseconds)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sigs
		logger.Printf("received %s, shutting down", s)
		cancel()
	}()

	r, err := lifecycle.New(ctx, cfg, logger)
	if err != nil {
		logger.Fatalf("init runner: %v", err)
	}
	if err := r.Run(ctx); err != nil && err != context.Canceled {
		logger.Fatalf("runner: %v", err)
	}
	logger.Println("bye")
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
		// Already-up-to-date case — Update logged it; nothing more to say.
		return
	}
	fmt.Printf("argus-sidecar updated to %s\n", tag)
}
