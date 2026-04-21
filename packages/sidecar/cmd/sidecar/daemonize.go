// Daemonize re-execs the current binary with a hidden marker arg so
// the child can run the existing foreground daemon while the parent
// returns control to the user's shell.
//
// We deliberately do NOT do a classic Unix double-fork. setsid is
// enough to detach from the controlling terminal on macOS+Linux,
// and Go's runtime makes a true fork() awkward (you cannot use any
// stdlib that touches the runtime in the child between fork and
// exec). Re-exec + setsid gets us the same observable behavior with
// dramatically simpler code.
//
// The hidden marker (`__daemon`) lives in os.Args so the child can
// detect that it's the spawned copy and skip the spawn step.

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// daemonChildArg is the sentinel inserted between argv[0] and the
// real flags so the child knows it's the spawned copy. Underscore
// prefix flags it as internal — operators should never pass it
// directly.
const daemonChildArg = "__daemon"

// SpawnDaemon detaches from the current TTY and re-executes this
// binary with the supplied user-facing args. The child will:
//
//  1. open `logPath` (append, create) and dup2 it onto stdout/stderr,
//  2. setsid into a new session (no controlling terminal),
//  3. acquire the pidfile lock,
//  4. run the existing foreground daemon loop.
//
// Returns the spawned child's PID after a brief liveness check
// (250 ms). If the child has died by then, we surface its exit
// code & the tail of the log so the user gets actionable output
// instead of a silent failure.
func SpawnDaemon(logPath string, args []string) (int, error) {
	self, err := os.Executable()
	if err != nil {
		return 0, fmt.Errorf("locate self: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return 0, fmt.Errorf("mkdir log dir: %w", err)
	}
	logFile, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return 0, fmt.Errorf("open log %s: %w", logPath, err)
	}

	// /dev/null for stdin so any accidental Read returns EOF
	// immediately instead of blocking.
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		_ = logFile.Close()
		return 0, fmt.Errorf("open /dev/null: %w", err)
	}

	childArgs := append([]string{daemonChildArg}, args...)
	cmd := exec.Command(self, childArgs...)
	cmd.Stdin = devNull
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = append(os.Environ(), "ARGUS_SIDECAR_LOG_PATH="+logPath)
	// Setsid drops the controlling terminal and creates a fresh
	// session/process-group. Setpgid alone would only break the
	// pgrp link and leave the child reachable via tcsetpgrp from
	// the foreground job, which can produce surprising SIGTTOU
	// behavior on logout.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		_ = devNull.Close()
		return 0, fmt.Errorf("spawn daemon: %w", err)
	}

	// Parent no longer needs these; the child inherited duped fds.
	_ = logFile.Close()
	_ = devNull.Close()

	// Capture the PID BEFORE Release(): Release() invalidates the
	// internal handle and resets cmd.Process.Pid to -1 on the
	// returned struct, so reading it afterwards yields nonsense.
	pid := cmd.Process.Pid

	// Release the child without waiting on it (otherwise the
	// parent blocks the shell until the daemon exits). We still
	// peek at it after a short delay to catch immediate boot
	// failures (bad config, port conflict, locked pidfile).
	if err := cmd.Process.Release(); err != nil {
		return 0, fmt.Errorf("release child: %w", err)
	}

	time.Sleep(250 * time.Millisecond)
	if !ProcessAlive(pid) {
		return 0, fmt.Errorf("daemon exited immediately — see %s for details", logPath)
	}
	return pid, nil
}

// IsDaemonChild reports whether the current invocation is the spawned
// copy (as opposed to the user's `start` invocation). When true, the
// caller should strip the marker arg from os.Args before parsing
// flags.
func IsDaemonChild() bool {
	return len(os.Args) >= 2 && os.Args[1] == daemonChildArg
}

// StripDaemonMarker removes the sentinel from os.Args so the rest of
// the program parses flags as if it were invoked normally. Returns
// the cleaned args slice (everything after argv[0]).
func StripDaemonMarker() []string {
	if !IsDaemonChild() {
		return os.Args[1:]
	}
	return os.Args[2:]
}
