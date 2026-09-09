// Service-manager integration: `argus-sidecar service install|uninstall|status`.
//
// Before this existed, backgrounding the sidecar meant reading
// INSTALLATION.md, pasting a unit file (systemd) or plist (launchd) into
// the right directory, hand-editing ExecStart to match wherever the
// binary actually landed, and remembering the daemon-reload/enable
// incantation. Every one of those inputs is something the running
// process already knows, so we render the unit from live state instead
// of asking the operator to transcribe it.
//
// Two things the hand-written recipes get wrong often enough to matter:
//
//   - PATH. Adapter discovery is `exec.LookPath` at boot (see
//     internal/machine/discovery.go), and systemd's default PATH is a
//     bare /usr/bin:/bin — it does NOT include ~/.local/bin, nvm shims,
//     ~/.bun/bin or Homebrew, which is exactly where claude/codex/
//     cursor-agent usually live. A unit without an explicit PATH boots
//     fine and then discovers zero adapters. We bake the PATH we were
//     invoked with (overridable via -path) so the service sees the same
//     CLIs the operator does.
//   - The [Install] target. A --user unit must be WantedBy=default.target;
//     multi-user.target (correct for system units, and what most copy-paste
//     recipes show) silently never starts at login.
//
// Scope defaults to a per-user unit: the sidecar spawns CLI agents that
// read the invoking user's credentials, config and PATH, so "runs as me"
// is almost always what's wanted. -system is opt-in for shared hosts.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/kr4t0n/argus/sidecar/internal/machine"
)

const (
	// systemdUnitName is the unit filename under either
	// ~/.config/systemd/user or /etc/systemd/system.
	systemdUnitName = "argus-sidecar.service"
	// launchdLabel matches the label documented in INSTALLATION.md so
	// operators migrating from the hand-written plist keep the same
	// `launchctl` handle.
	launchdLabel = "com.argus.sidecar"
)

// serviceConfig is everything the renderers need, resolved once up
// front so rendering itself stays pure (and therefore testable without
// touching the filesystem or a service manager).
type serviceConfig struct {
	// ExePath is the symlink-resolved absolute path to this binary.
	// Resolved rather than taken from argv so `service install` run
	// through a symlink still points the unit at the real file — which
	// is also the file `update` renames over.
	ExePath string
	// CachePath is a non-default cache location to pass through to
	// ExecStart. Empty means "let the daemon resolve XDG itself",
	// which keeps the common unit free of machine-specific paths.
	CachePath string
	// Account is the User= for system units. Empty for user units,
	// which inherit the owning account by construction.
	Account string
	// PATH is baked into the unit's environment (see the file comment).
	PATH string
	// System selects the system-wide manager domain over the per-user one.
	System bool
	// LogDir is where launchd should write stdout/stderr. Unused on
	// Linux, where the journal handles it.
	LogDir string
}

func runService(args []string) {
	if len(args) == 0 {
		printServiceUsage()
		os.Exit(exitGenericError)
	}
	switch args[0] {
	case "install":
		runServiceInstall(args[1:])
	case "uninstall", "remove":
		runServiceUninstall(args[1:])
	case "status":
		runServiceStatus(args[1:])
	case "help", "--help", "-h":
		printServiceUsage()
	default:
		fmt.Fprintf(os.Stderr, "argus-sidecar service: unknown subcommand %q\n\n", args[0])
		printServiceUsage()
		os.Exit(exitGenericError)
	}
}

func printServiceUsage() {
	fmt.Fprint(os.Stderr, `argus-sidecar service — install the sidecar as a managed background service

Usage:
  argus-sidecar service install [flags]    write + enable the unit (systemd or launchd)
  argus-sidecar service uninstall [flags]  stop, disable and remove the unit
  argus-sidecar service status [flags]     report unit path, enabled and active state

Install flags:
  -system            install system-wide (/etc/systemd/system, /Library/LaunchDaemons)
                     instead of per-user. Requires root.
  -user-account <u>  account the system unit runs as (default: the invoking user,
                     or $SUDO_USER when run through sudo). Ignored without -system.
  -cache <path>      pass an explicit cache path through to ExecStart
  -path <PATH>       PATH to bake into the unit (default: the PATH this command
                     was invoked with — that is where your agent CLIs were found)
  -dry-run           print the rendered unit to stdout and exit; touch nothing
  -no-start          write and enable the unit, but do not start it now
  -force             install even if no sidecar cache exists yet

Uninstall flags:
  -system            operate on the system-wide unit
  -keep-file         stop and disable, but leave the unit file on disk

Status flags:
  -system            operate on the system-wide unit

The unit runs `+"`argus-sidecar run`"+` in the foreground and lets the service
manager own restarts. After `+"`argus-sidecar update`"+`, restart it so the new
binary is picked up.
`)
}

// ── install ──────────────────────────────────────────────────────────

func runServiceInstall(args []string) {
	fs := flag.NewFlagSet("service install", flag.ExitOnError)
	system := fs.Bool("system", false, "install system-wide instead of per-user")
	account := fs.String("user-account", "", "account the system unit runs as")
	cachePath := fs.String("cache", "", "pass an explicit cache path through to ExecStart")
	pathEnv := fs.String("path", "", "PATH to bake into the unit")
	dryRun := fs.Bool("dry-run", false, "print the rendered unit and exit")
	noStart := fs.Bool("no-start", false, "enable the unit but do not start it now")
	force := fs.Bool("force", false, "install even if no sidecar cache exists yet")
	_ = fs.Parse(args)

	cfg, err := buildServiceConfig(*system, *account, *cachePath, *pathEnv)
	if err != nil {
		serviceFatal(err)
	}

	unitPath, err := serviceUnitPath(*system)
	if err != nil {
		serviceFatal(err)
	}
	rendered, err := renderService(cfg)
	if err != nil {
		serviceFatal(err)
	}

	if *dryRun {
		fmt.Fprintf(os.Stderr, "# would write %s\n", unitPath)
		fmt.Print(rendered)
		return
	}

	// Preflight: a unit whose daemon exits immediately ("no cache — run
	// init first") looks to systemd like a crash loop, and the operator
	// gets to debug it through journalctl instead of seeing the error
	// here. Check before we install rather than after.
	if err := checkCacheReady(cfg, *force); err != nil {
		serviceFatal(err)
	}
	if err := requirePrivilege(*system); err != nil {
		serviceFatal(err)
	}

	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		serviceFatal(fmt.Errorf("create %s: %w", filepath.Dir(unitPath), err))
	}
	if err := os.WriteFile(unitPath, []byte(rendered), 0o644); err != nil {
		serviceFatal(fmt.Errorf("write %s: %w", unitPath, err))
	}
	fmt.Printf("wrote %s\n", unitPath)

	if cfg.LogDir != "" {
		// launchd has no journal: it needs the log destination to exist
		// before it will spawn the job at all.
		if err := os.MkdirAll(cfg.LogDir, 0o755); err != nil {
			serviceFatal(fmt.Errorf("create log dir %s: %w", cfg.LogDir, err))
		}
	}

	if err := enableService(*system, *noStart); err != nil {
		serviceFatal(err)
	}

	printPostInstall(cfg, unitPath, *system, *noStart)
}

// buildServiceConfig resolves the live state the renderers need and
// applies the flag overrides on top.
func buildServiceConfig(system bool, account, cachePath, pathEnv string) (serviceConfig, error) {
	exe, err := os.Executable()
	if err != nil {
		return serviceConfig{}, fmt.Errorf("locate current executable: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	cfg := serviceConfig{
		ExePath:   exe,
		CachePath: cachePath,
		PATH:      pathEnv,
		System:    system,
	}
	if cfg.PATH == "" {
		cfg.PATH = os.Getenv("PATH")
	}
	if system {
		cfg.Account = account
		if cfg.Account == "" {
			cfg.Account = invokingUser()
		}
		if cfg.Account == "" {
			return serviceConfig{}, errors.New("could not determine the account to run as — pass -user-account")
		}
	}
	if runtime.GOOS == "darwin" {
		if system {
			cfg.LogDir = "/var/log"
		} else {
			home, err := os.UserHomeDir()
			if err != nil {
				return serviceConfig{}, fmt.Errorf("locate home dir: %w", err)
			}
			cfg.LogDir = filepath.Join(home, "Library", "Logs")
		}
	}
	return cfg, nil
}

// invokingUser prefers $SUDO_USER over the effective user so
// `sudo argus-sidecar service install -system` defaults to running the
// daemon as the human who typed it, not as root. Running the sidecar as
// root would hand every spawned agent CLI root as well.
func invokingUser() string {
	if u := os.Getenv("SUDO_USER"); u != "" && u != "root" {
		return u
	}
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return os.Getenv("USER")
}

// checkCacheReady fails when `init` has not run yet, so the operator
// sees the problem now instead of in journalctl. For a system unit
// running as somebody else we cannot read their home directory, so we
// warn about the account mismatch and let it through — the cache has to
// exist for the *target* account, not for whoever ran sudo.
func checkCacheReady(cfg serviceConfig, force bool) error {
	if cfg.System && cfg.Account != currentUsername() {
		fmt.Fprintf(os.Stderr, "note: the unit runs as %q — the sidecar cache must exist for that account\n", cfg.Account)
		fmt.Fprintf(os.Stderr, "      (run `sudo -u %s argus-sidecar init …`, or point the unit at a shared cache with -cache)\n", cfg.Account)
		return nil
	}
	path, err := resolveCachePath(cfg.CachePath)
	if err != nil {
		return err
	}
	if _, err := machine.Load(path); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("load cache %s: %w", path, err)
		}
		if !force {
			return fmt.Errorf("no sidecar cache at %s — run `argus-sidecar init` first (or pass -force)", path)
		}
		fmt.Fprintf(os.Stderr, "warning: no cache at %s — the service will crash-loop until you run `argus-sidecar init`\n", path)
	}
	return nil
}

func currentUsername() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return os.Getenv("USER")
}

// requirePrivilege rejects a system-scope operation early rather than
// letting it fail halfway through with a bare EACCES on the unit file.
func requirePrivilege(system bool) error {
	if system && os.Geteuid() != 0 {
		return errors.New("-system needs root — re-run with sudo")
	}
	return nil
}

func printPostInstall(cfg serviceConfig, unitPath string, system, noStart bool) {
	switch runtime.GOOS {
	case "linux":
		if !system {
			warnIfNoLinger()
		}
		fmt.Printf("\nservice installed (%s)\n", scopeLabel(system))
		fmt.Printf("  unit:    %s\n", unitPath)
		fmt.Printf("  logs:    %s\n", journalCmd(system))
		fmt.Printf("  restart: %s\n", systemctlCmd(system, "restart", systemdUnitName))
	case "darwin":
		fmt.Printf("\nservice installed (%s)\n", scopeLabel(system))
		fmt.Printf("  plist:   %s\n", unitPath)
		fmt.Printf("  logs:    %s\n", filepath.Join(cfg.LogDir, "argus-sidecar.err.log"))
		fmt.Printf("  restart: launchctl kickstart -k %s/%s\n", launchdDomain(system), launchdLabel)
	}
	if noStart {
		fmt.Println("\nnot started (-no-start). Start it when ready.")
	}
	fmt.Println("\n`argus-sidecar update` will offer to restart this service once it swaps the binary.")
}

func scopeLabel(system bool) string {
	if system {
		return "system-wide"
	}
	return "per-user"
}

// ── uninstall / status ───────────────────────────────────────────────

func runServiceUninstall(args []string) {
	fs := flag.NewFlagSet("service uninstall", flag.ExitOnError)
	system := fs.Bool("system", false, "operate on the system-wide unit")
	keepFile := fs.Bool("keep-file", false, "stop and disable but leave the unit file in place")
	_ = fs.Parse(args)

	unitPath, err := serviceUnitPath(*system)
	if err != nil {
		serviceFatal(err)
	}
	if err := requirePrivilege(*system); err != nil {
		serviceFatal(err)
	}

	// Disable before deleting: systemd resolves the unit file to find
	// the [Install] symlinks it needs to remove, so unlinking first
	// leaves a dangling wants/ entry behind.
	if err := disableService(*system); err != nil {
		// Not fatal — a half-installed unit (file present, never
		// enabled) should still be removable.
		fmt.Fprintf(os.Stderr, "warning: %v\n", err)
	}

	if *keepFile {
		fmt.Printf("stopped and disabled; unit left at %s\n", unitPath)
		return
	}
	if err := os.Remove(unitPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Printf("no unit at %s — nothing to remove\n", unitPath)
			return
		}
		serviceFatal(fmt.Errorf("remove %s: %w", unitPath, err))
	}
	if runtime.GOOS == "linux" {
		_ = runSystemctl(*system, "daemon-reload")
	}
	fmt.Printf("removed %s\n", unitPath)
}

func runServiceStatus(args []string) {
	fs := flag.NewFlagSet("service status", flag.ExitOnError)
	system := fs.Bool("system", false, "operate on the system-wide unit")
	_ = fs.Parse(args)

	unitPath, err := serviceUnitPath(*system)
	if err != nil {
		serviceFatal(err)
	}
	installed := true
	if _, err := os.Stat(unitPath); err != nil {
		installed = false
	}

	fmt.Printf("argus-sidecar service (%s)\n", scopeLabel(*system))
	fmt.Printf("  unit:      %s\n", unitPath)
	if !installed {
		fmt.Println("  installed: no")
		fmt.Println("\nInstall it with: argus-sidecar service install")
		os.Exit(exitStatusStopped)
	}
	fmt.Println("  installed: yes")

	active := serviceActive(*system)
	fmt.Printf("  enabled:   %s\n", serviceEnabled(*system))
	fmt.Printf("  active:    %s\n", active)
	if active == "active" {
		os.Exit(exitStatusRunning)
	}
	os.Exit(exitStatusStopped)
}

// serviceFatal keeps error formatting identical to the other control
// subcommands (see control.go) so scripted callers see one convention.
func serviceFatal(err error) {
	fmt.Fprintf(os.Stderr, "argus-sidecar service: %v\n", err)
	os.Exit(exitGenericError)
}

// ── unit paths + rendering ───────────────────────────────────────────

func serviceUnitPath(system bool) (string, error) {
	switch runtime.GOOS {
	case "linux":
		return systemdUnitPath(system)
	case "darwin":
		return launchdPlistPath(system)
	default:
		return "", fmt.Errorf("no service-manager integration for %s — run `argus-sidecar start` instead", runtime.GOOS)
	}
}

// systemdUnitPath honours XDG_CONFIG_HOME for user units because
// systemd itself does; a unit written to ~/.config while the operator
// has XDG_CONFIG_HOME pointed elsewhere would simply never be found.
func systemdUnitPath(system bool) (string, error) {
	if system {
		return filepath.Join("/etc/systemd/system", systemdUnitName), nil
	}
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "systemd", "user", systemdUnitName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home dir: %w", err)
	}
	return filepath.Join(home, ".config", "systemd", "user", systemdUnitName), nil
}

func launchdPlistPath(system bool) (string, error) {
	if system {
		return filepath.Join("/Library/LaunchDaemons", launchdLabel+".plist"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home dir: %w", err)
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist"), nil
}

func renderService(cfg serviceConfig) (string, error) {
	switch runtime.GOOS {
	case "linux":
		return renderSystemdUnit(cfg), nil
	case "darwin":
		return renderLaunchdPlist(cfg), nil
	default:
		return "", fmt.Errorf("no service-manager integration for %s", runtime.GOOS)
	}
}

func renderSystemdUnit(cfg serviceConfig) string {
	var b strings.Builder
	b.WriteString("# Generated by `argus-sidecar service install`. Re-running the\n")
	b.WriteString("# command overwrites this file; hand edits will not survive.\n")
	b.WriteString("[Unit]\n")
	b.WriteString("Description=Argus sidecar\n")
	b.WriteString("Documentation=https://github.com/kr4t0n/argus/blob/main/INSTALLATION.md\n")
	b.WriteString("After=network-online.target\n")
	b.WriteString("Wants=network-online.target\n\n")

	b.WriteString("[Service]\n")
	b.WriteString("Type=simple\n")
	b.WriteString("ExecStart=" + strings.Join(execStartArgv(cfg), " ") + "\n")
	if cfg.Account != "" {
		b.WriteString("User=" + cfg.Account + "\n")
	}
	if cfg.PATH != "" {
		// Quoted because a PATH entry may legitimately contain spaces,
		// and systemd splits Environment= on whitespace otherwise.
		b.WriteString("Environment=\"PATH=" + cfg.PATH + "\"\n")
	}
	b.WriteString("Restart=on-failure\n")
	b.WriteString("RestartSec=5\n")
	b.WriteString("StandardOutput=journal\n")
	b.WriteString("StandardError=journal\n\n")

	b.WriteString("[Install]\n")
	// A --user unit is pulled in by default.target at login;
	// multi-user.target only exists in the system manager.
	if cfg.System {
		b.WriteString("WantedBy=multi-user.target\n")
	} else {
		b.WriteString("WantedBy=default.target\n")
	}
	return b.String()
}

func renderLaunchdPlist(cfg serviceConfig) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"` + "\n")
	b.WriteString(`  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	b.WriteString("<!-- Generated by `argus-sidecar service install`. Re-running the\n")
	b.WriteString("     command overwrites this file; hand edits will not survive. -->\n")
	b.WriteString(`<plist version="1.0"><dict>` + "\n")
	b.WriteString("  <key>Label</key><string>" + plistEscape(launchdLabel) + "</string>\n")
	b.WriteString("  <key>ProgramArguments</key>\n  <array>\n")
	for _, arg := range execStartArgvRaw(cfg) {
		b.WriteString("    <string>" + plistEscape(arg) + "</string>\n")
	}
	b.WriteString("  </array>\n")
	if cfg.Account != "" {
		b.WriteString("  <key>UserName</key><string>" + plistEscape(cfg.Account) + "</string>\n")
	}
	b.WriteString("  <key>RunAtLoad</key><true/>\n")
	b.WriteString("  <key>KeepAlive</key><true/>\n")
	b.WriteString("  <key>StandardOutPath</key><string>" + plistEscape(filepath.Join(cfg.LogDir, "argus-sidecar.out.log")) + "</string>\n")
	b.WriteString("  <key>StandardErrorPath</key><string>" + plistEscape(filepath.Join(cfg.LogDir, "argus-sidecar.err.log")) + "</string>\n")
	if cfg.PATH != "" {
		b.WriteString("  <key>EnvironmentVariables</key>\n  <dict>\n")
		b.WriteString("    <key>PATH</key><string>" + plistEscape(cfg.PATH) + "</string>\n")
		b.WriteString("  </dict>\n")
	}
	b.WriteString("</dict></plist>\n")
	return b.String()
}

// execStartArgvRaw is the argv the service manager should exec. The
// `run` alias is used over a bare invocation because it reads
// unambiguously in a unit file (main.go documents it for exactly this).
func execStartArgvRaw(cfg serviceConfig) []string {
	argv := []string{cfg.ExePath, "run"}
	if cfg.CachePath != "" {
		argv = append(argv, "-cache", cfg.CachePath)
	}
	return argv
}

// execStartArgv is execStartArgvRaw with systemd quoting applied, for
// the single-line ExecStart= form.
func execStartArgv(cfg serviceConfig) []string {
	raw := execStartArgvRaw(cfg)
	out := make([]string, len(raw))
	for i, arg := range raw {
		out[i] = systemdQuote(arg)
	}
	return out
}

// systemdQuote wraps an argument in double quotes when it contains
// whitespace, which systemd would otherwise treat as an argument
// separator. Paths with spaces are rare but a silently mis-split
// ExecStart is a miserable thing to debug.
func systemdQuote(s string) string {
	if !strings.ContainsAny(s, " \t") {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

var plistEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

func plistEscape(s string) string { return plistEscaper.Replace(s) }

// ── service-manager drivers ──────────────────────────────────────────

func enableService(system, noStart bool) error {
	switch runtime.GOOS {
	case "linux":
		if err := runSystemctl(system, "daemon-reload"); err != nil {
			return err
		}
		verb := []string{"enable", "--now", systemdUnitName}
		if noStart {
			verb = []string{"enable", systemdUnitName}
		}
		return runSystemctl(system, verb...)
	case "darwin":
		path, err := launchdPlistPath(system)
		if err != nil {
			return err
		}
		domain := launchdDomain(system)
		// bootout first so a re-install replaces a loaded job instead
		// of failing with "service already loaded". Errors here are
		// expected on a first install.
		_ = exec.Command("launchctl", "bootout", domain+"/"+launchdLabel).Run()
		if out, err := exec.Command("launchctl", "bootstrap", domain, path).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl bootstrap: %w: %s", err, strings.TrimSpace(string(out)))
		}
		if noStart {
			return nil
		}
		if out, err := exec.Command("launchctl", "kickstart", "-k", domain+"/"+launchdLabel).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl kickstart: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	default:
		return fmt.Errorf("no service-manager integration for %s", runtime.GOOS)
	}
}

func disableService(system bool) error {
	switch runtime.GOOS {
	case "linux":
		if err := runSystemctl(system, "disable", "--now", systemdUnitName); err != nil {
			return err
		}
		return nil
	case "darwin":
		domain := launchdDomain(system)
		if out, err := exec.Command("launchctl", "bootout", domain+"/"+launchdLabel).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl bootout: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	default:
		return fmt.Errorf("no service-manager integration for %s", runtime.GOOS)
	}
}

func runSystemctl(system bool, args ...string) error {
	full := systemctlArgs(system, args...)
	out, err := exec.Command("systemctl", full...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		// The overwhelmingly common failure for `--user` is being in a
		// context with no user session bus (ssh without lingering, a
		// container, or a sudo shell). Say so, because systemd's own
		// "Failed to connect to bus" tells you nothing actionable.
		if !system && strings.Contains(msg, "bus") {
			return fmt.Errorf("systemctl --user %s: %s\n"+
				"  no user session bus here — log in directly on this host, or install system-wide with -system",
				strings.Join(args, " "), msg)
		}
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(full, " "), err, msg)
	}
	return nil
}

func systemctlArgs(system bool, args ...string) []string {
	if system {
		return args
	}
	return append([]string{"--user"}, args...)
}

func systemctlCmd(system bool, args ...string) string {
	prefix := "systemctl "
	if system {
		prefix = "sudo systemctl "
	}
	return prefix + strings.Join(systemctlArgs(system, args...), " ")
}

func journalCmd(system bool) string {
	if system {
		return "sudo journalctl -u " + systemdUnitName + " -f"
	}
	return "journalctl --user -u " + systemdUnitName + " -f"
}

func launchdDomain(system bool) string {
	if system {
		return "system"
	}
	return fmt.Sprintf("gui/%d", os.Getuid())
}

// serviceEnabled / serviceActive report state as a short word for
// `service status`. Both are best-effort: a manager that cannot be
// queried yields "unknown" rather than an error, since status must
// stay useful on a half-configured host.
func serviceEnabled(system bool) string {
	switch runtime.GOOS {
	case "linux":
		out, _ := exec.Command("systemctl", systemctlArgs(system, "is-enabled", systemdUnitName)...).Output()
		if s := strings.TrimSpace(string(out)); s != "" {
			return s
		}
		return "unknown"
	case "darwin":
		// A bootstrapped launchd job with RunAtLoad is enabled by
		// definition; presence in the domain is the closest analogue.
		if err := exec.Command("launchctl", "print", launchdDomain(system)+"/"+launchdLabel).Run(); err == nil {
			return "loaded"
		}
		return "not-loaded"
	default:
		return "unknown"
	}
}

func serviceActive(system bool) string {
	switch runtime.GOOS {
	case "linux":
		out, _ := exec.Command("systemctl", systemctlArgs(system, "is-active", systemdUnitName)...).Output()
		if s := strings.TrimSpace(string(out)); s != "" {
			return s
		}
		return "unknown"
	case "darwin":
		// `launchctl list <label>` exits non-zero when the job is not
		// loaded; when loaded, column 1 is the PID or "-" if not running.
		out, err := exec.Command("launchctl", "list", launchdLabel).Output()
		if err != nil {
			return "inactive"
		}
		fields := strings.Fields(string(out))
		if len(fields) > 0 && fields[0] != "-" {
			return "active"
		}
		return "inactive"
	default:
		return "unknown"
	}
}

// ── restart-after-update ─────────────────────────────────────────────

const (
	restartViaService = "service" // systemd unit or launchd job
	restartViaDaemon  = "daemon"  // backgrounded by `argus-sidecar start`
)

// restartPlan describes how a sidecar already running on this host would
// be restarted. A swapped binary changes nothing until the running
// process is replaced — os.Rename leaves the live process on the old
// inode — so `update` uses this to offer the restart instead of printing
// a command and hoping.
type restartPlan struct {
	Kind    string // restartViaService, restartViaDaemon, or "" when nothing is running
	System  bool   // service scope, when Kind is restartViaService
	Label   string // human description for the prompt
	Command string // equivalent shell command, for the non-interactive hint
}

// detectRestartPlan reports how the local sidecar is being supervised.
//
// A managed service is checked first and wins outright. Under systemd
// the daemon still holds the usual pidfile, so the daemon branch would
// also match — but SIGTERMing it exits 0, which Restart=on-failure does
// NOT respawn, and the subsequent `start` would spawn a detached process
// outside the unit. Getting this order wrong silently orphans the
// service.
func detectRestartPlan() restartPlan {
	for _, system := range []bool{false, true} {
		unitPath, err := serviceUnitPath(system)
		if err != nil {
			return restartPlan{} // GOOS with no service-manager support
		}
		if _, err := os.Stat(unitPath); err != nil {
			continue
		}
		if serviceActive(system) != "active" {
			continue
		}
		plan := restartPlan{Kind: restartViaService, System: system}
		switch runtime.GOOS {
		case "darwin":
			plan.Label = fmt.Sprintf("the launchd job (%s)", scopeLabel(system))
			plan.Command = fmt.Sprintf("launchctl kickstart -k %s/%s", launchdDomain(system), launchdLabel)
		default:
			plan.Label = fmt.Sprintf("the %s systemd unit", scopeLabel(system))
			plan.Command = systemctlCmd(system, "restart", systemdUnitName)
		}
		return plan
	}

	pidPath, err := resolvePIDPath("")
	if err != nil {
		return restartPlan{}
	}
	if pid, _ := ReadPIDFile(pidPath); pid > 0 && ProcessAlive(pid) {
		return restartPlan{
			Kind:    restartViaDaemon,
			Label:   fmt.Sprintf("the background daemon (pid=%d)", pid),
			Command: "argus-sidecar restart",
		}
	}
	return restartPlan{}
}

func performRestart(plan restartPlan) error {
	switch plan.Kind {
	case restartViaService:
		switch runtime.GOOS {
		case "darwin":
			target := launchdDomain(plan.System) + "/" + launchdLabel
			if out, err := exec.Command("launchctl", "kickstart", "-k", target).CombinedOutput(); err != nil {
				return fmt.Errorf("launchctl kickstart: %w: %s", err, strings.TrimSpace(string(out)))
			}
			return nil
		default:
			return runSystemctl(plan.System, "restart", systemdUnitName)
		}
	case restartViaDaemon:
		// Reuse the `restart` subcommand wholesale: it stops the old
		// process and re-spawns from os.Executable(), which is the
		// path the swap just landed on.
		runRestart(nil)
		return nil
	}
	return nil
}

// warnIfNoLinger flags the one thing that makes a --user unit look
// broken: without lingering, systemd tears the user manager down at
// logout, so the sidecar dies when the ssh session ends and never
// starts at boot. Best-effort — loginctl is absent on some systems.
func warnIfNoLinger() {
	u := currentUsername()
	if u == "" {
		return
	}
	out, err := exec.Command("loginctl", "show-user", u, "--property=Linger", "--value").Output()
	if err != nil {
		return
	}
	if strings.TrimSpace(string(out)) == "yes" {
		return
	}
	fmt.Fprintf(os.Stderr, "\nwarning: lingering is off for %q — the service will stop when you log out\n", u)
	fmt.Fprintf(os.Stderr, "         enable it with: sudo loginctl enable-linger %s\n", u)
}
