// Daemon control subcommands: start / stop / restart / status.
//
// All four operate purely against the local pidfile + the running
// process — they never touch the cache (other than reading it for
// `status` enrichment) and they never talk to Redis or the server.
// That keeps them fast, offline-safe, and useful as a first
// debugging step ("is the daemon even running?").

package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/kyley/argus/sidecar/internal/machine"
)

const (
	exitStatusRunning  = 0 // status: live daemon (or stop: succeeded)
	exitStatusDeadFile = 1 // status: pidfile exists but process gone
	exitStatusStopped  = 3 // status: no pidfile / cleanly stopped
	exitGenericError   = 2 // bad flag / IO error / etc.
)

func runStart(args []string) {
	fs := flag.NewFlagSet("start", flag.ExitOnError)
	pidPath := fs.String("pid-file", "", "override the pidfile path (default XDG state dir)")
	logPath := fs.String("log-file", "", "override the daemon log path (default XDG state dir)")
	cachePath := fs.String("cache", "", "path to sidecar cache (default: $XDG_CONFIG_HOME/argus/sidecar.json)")
	_ = fs.Parse(args)

	resolvedPID, err := resolvePIDPath(*pidPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar start: %v\n", err)
		os.Exit(exitGenericError)
	}
	resolvedLog, err := resolveLogPath(*logPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar start: %v\n", err)
		os.Exit(exitGenericError)
	}

	// Fail fast if a daemon is already running. We check the lock
	// rather than the PID number because the PID could have been
	// reused by an unrelated process — the flock is the source of
	// truth.
	if locked, _ := PIDFileLocked(resolvedPID); locked {
		pid, _ := ReadPIDFile(resolvedPID)
		fmt.Fprintf(os.Stderr, "argus-sidecar already running (pid=%d, lock=%s)\n", pid, resolvedPID)
		os.Exit(exitGenericError)
	}

	// Forward overrides + cache through to the child so the
	// spawned daemon respects whatever the operator passed to
	// `start` (otherwise the child would re-resolve from env and
	// could disagree with the parent about where the pidfile is).
	childArgs := []string{}
	if *cachePath != "" {
		childArgs = append(childArgs, "-cache", *cachePath)
	}
	if *pidPath != "" {
		childArgs = append(childArgs, "-pid-file", *pidPath)
	}
	if *logPath != "" {
		childArgs = append(childArgs, "-log-file", *logPath)
	}

	pid, err := SpawnDaemon(resolvedLog, childArgs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar start: %v\n", err)
		os.Exit(exitGenericError)
	}
	fmt.Printf("argus-sidecar started (pid=%d)\n", pid)
	fmt.Printf("  log:     %s\n", resolvedLog)
	fmt.Printf("  pidfile: %s\n", resolvedPID)
}

func runStop(args []string) {
	fs := flag.NewFlagSet("stop", flag.ExitOnError)
	pidPath := fs.String("pid-file", "", "override the pidfile path")
	timeout := fs.Duration("timeout", 10*time.Second, "max wait for graceful shutdown before SIGKILL")
	force := fs.Bool("force", false, "skip SIGTERM, send SIGKILL immediately")
	_ = fs.Parse(args)

	resolvedPID, err := resolvePIDPath(*pidPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar stop: %v\n", err)
		os.Exit(exitGenericError)
	}

	pid, err := ReadPIDFile(resolvedPID)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar stop: %v\n", err)
		os.Exit(exitGenericError)
	}
	if pid == 0 || !ProcessAlive(pid) {
		// Tidy up any stale pidfile so a subsequent `start`
		// doesn't trip on it.
		_ = os.Remove(resolvedPID)
		fmt.Println("argus-sidecar is not running")
		return
	}

	sig := syscall.SIGTERM
	if *force {
		sig = syscall.SIGKILL
	}
	if err := syscall.Kill(pid, sig); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			_ = os.Remove(resolvedPID)
			fmt.Println("argus-sidecar is not running")
			return
		}
		fmt.Fprintf(os.Stderr, "argus-sidecar stop: signal %d: %v\n", sig, err)
		os.Exit(exitGenericError)
	}

	if *force {
		fmt.Printf("argus-sidecar killed (pid=%d, SIGKILL)\n", pid)
		_ = os.Remove(resolvedPID)
		return
	}

	// Poll for the process to exit. 100 ms granularity is plenty
	// — the daemon's shutdown path (cancel ctx → close adapters)
	// usually finishes in a couple hundred ms, and we don't want
	// to busy-wait.
	deadline := time.Now().Add(*timeout)
	for time.Now().Before(deadline) {
		if !ProcessAlive(pid) {
			fmt.Printf("argus-sidecar stopped (pid=%d)\n", pid)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}

	// Graceful window expired; escalate.
	fmt.Fprintf(os.Stderr, "argus-sidecar still alive after %s, sending SIGKILL\n", *timeout)
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		fmt.Fprintf(os.Stderr, "argus-sidecar stop: SIGKILL: %v\n", err)
		os.Exit(exitGenericError)
	}
	// Leave the pidfile intact + exit non-zero so an automated
	// caller (or a confused operator) notices the hard kill.
	os.Exit(exitGenericError)
}

func runRestart(args []string) {
	// Split args between the sub-commands. We reuse the same
	// flagset shape so `restart --pid-file` works the obvious way.
	fs := flag.NewFlagSet("restart", flag.ExitOnError)
	pidPath := fs.String("pid-file", "", "override the pidfile path")
	logPath := fs.String("log-file", "", "override the daemon log path")
	cachePath := fs.String("cache", "", "path to sidecar cache")
	timeout := fs.Duration("timeout", 10*time.Second, "max wait for graceful shutdown before SIGKILL")
	_ = fs.Parse(args)

	stopArgs := []string{}
	if *pidPath != "" {
		stopArgs = append(stopArgs, "-pid-file", *pidPath)
	}
	stopArgs = append(stopArgs, "-timeout", timeout.String())

	startArgs := []string{}
	if *pidPath != "" {
		startArgs = append(startArgs, "-pid-file", *pidPath)
	}
	if *logPath != "" {
		startArgs = append(startArgs, "-log-file", *logPath)
	}
	if *cachePath != "" {
		startArgs = append(startArgs, "-cache", *cachePath)
	}

	// Best-effort stop — `not running` is fine for a restart.
	stopBestEffort(stopArgs)
	runStart(startArgs)
}

// stopBestEffort wraps runStop for the restart path, swallowing the
// "not running" exit while still surfacing real errors. It works by
// peeking at the pidfile rather than re-running the full subcommand
// (which would call os.Exit and prevent us from continuing into
// `start`).
func stopBestEffort(args []string) {
	fs := flag.NewFlagSet("stop", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	pidPath := fs.String("pid-file", "", "")
	timeout := fs.Duration("timeout", 10*time.Second, "")
	_ = fs.Parse(args)

	resolvedPID, err := resolvePIDPath(*pidPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar restart: %v\n", err)
		os.Exit(exitGenericError)
	}
	pid, _ := ReadPIDFile(resolvedPID)
	if pid == 0 || !ProcessAlive(pid) {
		_ = os.Remove(resolvedPID)
		return
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		fmt.Fprintf(os.Stderr, "argus-sidecar restart: SIGTERM: %v\n", err)
		os.Exit(exitGenericError)
	}
	deadline := time.Now().Add(*timeout)
	for time.Now().Before(deadline) {
		if !ProcessAlive(pid) {
			fmt.Printf("argus-sidecar stopped (pid=%d)\n", pid)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	fmt.Fprintf(os.Stderr, "argus-sidecar still alive after %s, sending SIGKILL\n", *timeout)
	_ = syscall.Kill(pid, syscall.SIGKILL)
	os.Exit(exitGenericError)
}

func runStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	pidPath := fs.String("pid-file", "", "override the pidfile path")
	logPath := fs.String("log-file", "", "override the daemon log path")
	cachePath := fs.String("cache", "", "path to sidecar cache")
	_ = fs.Parse(args)

	resolvedPID, err := resolvePIDPath(*pidPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar status: %v\n", err)
		os.Exit(exitGenericError)
	}
	resolvedLog, err := resolveLogPath(*logPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar status: %v\n", err)
		os.Exit(exitGenericError)
	}
	resolvedCache, err := resolveCachePath(*cachePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-sidecar status: %v\n", err)
		os.Exit(exitGenericError)
	}

	pid, _ := ReadPIDFile(resolvedPID)
	locked, _ := PIDFileLocked(resolvedPID)
	cache, _ := machine.Load(resolvedCache)

	fmt.Printf("argus-sidecar %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
	fmt.Printf("  cache:   %s\n", resolvedCache)
	fmt.Printf("  pidfile: %s\n", resolvedPID)
	fmt.Printf("  log:     %s\n", resolvedLog)
	if cache != nil {
		fmt.Printf("  machine: %s (id=%s)\n", cache.Name, cache.MachineID)
		fmt.Printf("  agents:  %d configured\n", len(cache.Agents))
	}

	switch {
	case locked && pid > 0 && ProcessAlive(pid):
		uptime := processUptime(pid)
		fmt.Printf("  status:  running (pid=%d", pid)
		if uptime > 0 {
			fmt.Printf(", uptime=%s", uptime.Round(time.Second))
		}
		fmt.Println(")")
		os.Exit(exitStatusRunning)
	case pid > 0:
		fmt.Printf("  status:  stale pidfile (pid=%d not running)\n", pid)
		os.Exit(exitStatusDeadFile)
	default:
		fmt.Println("  status:  stopped")
		os.Exit(exitStatusStopped)
	}
}

// processUptime returns the elapsed time since the process named by
// `pid` started, derived from the mtime of /proc/<pid> (Linux) or
// the executable file's stat (fallback). Best-effort: returns 0 if
// we can't determine it without spawning ps. macOS doesn't expose
// /proc, so on darwin this returns 0 (we still print pid + status,
// just without uptime — explicit `ps -o etime= -p <pid>` is the
// suggested follow-up if a user really needs it).
func processUptime(pid int) time.Duration {
	if runtime.GOOS != "linux" {
		return 0
	}
	st, err := os.Stat(filepath.Join("/proc", fmt.Sprintf("%d", pid)))
	if err != nil {
		return 0
	}
	return time.Since(st.ModTime())
}
