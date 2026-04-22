// Tests for detectRestartMode. The motivating case is the
// "argus-sidecar start" daemon-child path: SpawnDaemon dup2s
// /dev/null onto the child's stdin and the log file onto stderr,
// then setsid's. The detection logic must classify that as
// RestartSelf (so update.go can syscall.Exec into the new binary).
//
// The original implementation gated on os.ModeCharDevice, which
// matches /dev/null too — so the daemon child looked like a
// foreground TTY and got RestartManual. This test pins the contract
// in the form that catches that bug.
package machine

import (
	"os"
	"path/filepath"
	"testing"
)

// withStdio swaps os.Stdin/os.Stderr for the duration of the test
// and restores them via t.Cleanup. detectRestartMode reads the
// globals directly, so this is the only way to exercise it.
func withStdio(t *testing.T, stdin, stderr *os.File) {
	t.Helper()
	origIn, origErr := os.Stdin, os.Stderr
	os.Stdin = stdin
	os.Stderr = stderr
	t.Cleanup(func() {
		os.Stdin = origIn
		os.Stderr = origErr
	})
}

// clearSupervisorEnv ensures the supervisor branch doesn't fire
// just because the test host happens to run under systemd/launchd.
// t.Setenv sets the value AND restores the original on cleanup.
func clearSupervisorEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"INVOCATION_ID", "NOTIFY_SOCKET", "XPC_SERVICE_NAME"} {
		t.Setenv(k, "")
	}
}

func TestDetectRestartMode_DaemonChildIsSelf(t *testing.T) {
	clearSupervisorEnv(t)

	// Mirror SpawnDaemon: stdin -> /dev/null, stderr -> regular log file.
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatalf("open /dev/null: %v", err)
	}
	defer devNull.Close()

	logPath := filepath.Join(t.TempDir(), "sidecar.log")
	logFile, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatalf("open log: %v", err)
	}
	defer logFile.Close()

	withStdio(t, devNull, logFile)

	got := detectRestartMode()
	if got != RestartSelf {
		t.Fatalf("daemon-child setup (stdin=/dev/null, stderr=logfile) "+
			"should yield RestartSelf, got %q — detection is mis-classifying "+
			"/dev/null as a TTY because os.ModeCharDevice matches both", got)
	}
}

func TestDetectRestartMode_SupervisorEnvWins(t *testing.T) {
	// Even with a TTY-ish stdio, an explicit supervisor marker has to win.
	clearSupervisorEnv(t)
	t.Setenv("INVOCATION_ID", "deadbeef")

	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatalf("open /dev/null: %v", err)
	}
	defer devNull.Close()
	withStdio(t, devNull, devNull)

	if got := detectRestartMode(); got != RestartSupervisor {
		t.Fatalf("INVOCATION_ID set should yield RestartSupervisor, got %q", got)
	}
}

func TestDetectRestartMode_RegularFilesAreSelf(t *testing.T) {
	// Regular file fds (no char-device bit, no TTY) — same path as
	// the daemon child once we stop confusing /dev/null with a TTY.
	clearSupervisorEnv(t)

	dir := t.TempDir()
	in, err := os.OpenFile(filepath.Join(dir, "in"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		t.Fatalf("open in: %v", err)
	}
	defer in.Close()
	errf, err := os.OpenFile(filepath.Join(dir, "err"), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		t.Fatalf("open err: %v", err)
	}
	defer errf.Close()
	withStdio(t, in, errf)

	if got := detectRestartMode(); got != RestartSelf {
		t.Fatalf("regular file stdio should yield RestartSelf, got %q", got)
	}
}
