// PID file + advisory lock for the sidecar daemon.
//
// The pidfile lives next to the cache by default but in the XDG state
// dir so it isn't backed up with config:
//
//	$XDG_STATE_HOME/argus/sidecar.pid   (default: ~/.local/state/argus/sidecar.pid)
//
// Both the foreground and the daemonized child take an exclusive
// flock(2) on this file at startup. That makes the file self-healing
// (the lock auto-releases on crash, so a stale PID never blocks the
// next start) and serves as the source of truth for `status`/`stop`:
// if no one holds the lock, no one's running, regardless of what the
// PID inside the file says.

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// PIDFile is a write-once handle on the sidecar's pidfile. The
// returned *os.File keeps the flock alive for the lifetime of the
// process; callers must hold the reference (do not close it) until
// shutdown. Release() is provided for explicit cleanup paths.
type PIDFile struct {
	Path string
	f    *os.File
}

// resolvePIDPath returns the configured pidfile path. Honors:
//
//  1. explicit --pid-file flag (override)
//  2. $ARGUS_STATE_DIR/sidecar.pid
//  3. $XDG_STATE_HOME/argus/sidecar.pid
//  4. ~/.local/state/argus/sidecar.pid
//
// macOS doesn't ship XDG defaults but Go tools have converged on
// honoring $XDG_STATE_HOME if set and falling back to the same
// ~/.local/state convention as Linux. Keeping one rule across both
// platforms beats sprinkling per-OS branches.
func resolvePIDPath(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if dir := os.Getenv("ARGUS_STATE_DIR"); dir != "" {
		return filepath.Join(dir, "sidecar.pid"), nil
	}
	if dir := os.Getenv("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "argus", "sidecar.pid"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home dir: %w", err)
	}
	return filepath.Join(home, ".local", "state", "argus", "sidecar.pid"), nil
}

// resolveLogPath mirrors resolvePIDPath but for the daemon log. We keep
// them under the same parent so a single mkdir covers both and operators
// only have one directory to point logrotate/newsyslog at.
func resolveLogPath(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if dir := os.Getenv("ARGUS_STATE_DIR"); dir != "" {
		return filepath.Join(dir, "sidecar.log"), nil
	}
	if dir := os.Getenv("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "argus", "sidecar.log"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home dir: %w", err)
	}
	return filepath.Join(home, ".local", "state", "argus", "sidecar.log"), nil
}

// AcquirePIDFile takes an exclusive non-blocking flock on the pidfile,
// truncates it, and writes the current PID. If another process holds
// the lock, returns an ErrLocked-wrapped error along with that PID so
// the caller can render a useful message ("already running, pid=…").
//
// The returned *PIDFile must be kept alive for the duration of the
// daemon. Closing the underlying *os.File releases the flock — that's
// what we want on graceful shutdown (Release()), but we explicitly do
// NOT defer Close() in the caller.
func AcquirePIDFile(path string) (*PIDFile, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		// Best-effort read of the existing PID so the caller can
		// surface a useful "already running, pid=N" message. We
		// don't block on the lock here — a real conflict should
		// fail fast, not hang.
		body, _ := os.ReadFile(path)
		_ = f.Close()
		pid, _ := strconv.Atoi(strings.TrimSpace(string(body)))
		return nil, &ErrLocked{Path: path, PID: pid, Err: err}
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("truncate %s: %w", path, err)
	}
	if _, err := f.Seek(0, 0); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("seek %s: %w", path, err)
	}
	if _, err := fmt.Fprintf(f, "%d\n", os.Getpid()); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("fsync %s: %w", path, err)
	}
	return &PIDFile{Path: path, f: f}, nil
}

// Release drops the flock and removes the pidfile. Safe to call from
// shutdown paths; ignores already-cleaned state.
func (p *PIDFile) Release() {
	if p == nil || p.f == nil {
		return
	}
	_ = syscall.Flock(int(p.f.Fd()), syscall.LOCK_UN)
	_ = p.f.Close()
	p.f = nil
	_ = os.Remove(p.Path)
}

// ReadPIDFile parses the PID from the pidfile without touching the
// lock. Returns (0, nil) if the file doesn't exist — callers treat
// that as "no daemon recorded".
func ReadPIDFile(path string) (int, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	s := strings.TrimSpace(string(body))
	if s == "" {
		return 0, nil
	}
	pid, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("parse %s: %w", path, err)
	}
	return pid, nil
}

// PIDFileLocked reports whether some process currently holds the
// flock on the pidfile. Used by `status` to distinguish a live
// daemon (locked) from a stale pidfile (PID exists, lock free).
//
// Implemented by trying to take a non-blocking shared lock on a
// freshly-opened fd: if that succeeds, no exclusive holder exists
// and we release immediately so the actual daemon can keep its
// hold.
func PIDFileLocked(path string) (bool, error) {
	f, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); err != nil {
		// EWOULDBLOCK / EAGAIN means an exclusive holder exists.
		if err == syscall.EWOULDBLOCK || err == syscall.EAGAIN {
			return true, nil
		}
		return false, err
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false, nil
}

// ProcessAlive reports whether `pid` names a live process. signal 0
// is the standard "are you there" probe — never delivered, but the
// kernel still validates the PID and returns ESRCH if the process
// is gone (or EPERM if we're not allowed to signal it, which we
// treat as "alive but foreign").
//
// We use syscall.Kill directly rather than os.Process.Signal because
// the latter routes through a cached *os.Process handle that may
// have been Release()d (notably by SpawnDaemon, which deliberately
// detaches the child) — on macOS that yields "os: process already
// finished" even when the kernel still has a live entry for the PID.
// syscall.Kill is unconditional and matches the Unix idiom.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, syscall.Signal(0))
	if err == nil {
		return true
	}
	// EPERM means "you can't signal it, but it exists." That
	// shouldn't happen for our own daemon, but treat it as alive
	// to avoid false negatives if the operator manages to wedge
	// the pidfile under another uid.
	return err == syscall.EPERM
}

// ErrLocked is returned by AcquirePIDFile when another process
// already holds the flock. Carries the conflicting PID (best-effort)
// so the caller can produce an actionable message.
type ErrLocked struct {
	Path string
	PID  int
	Err  error
}

func (e *ErrLocked) Error() string {
	if e.PID > 0 {
		return fmt.Sprintf("another argus-sidecar is already running (pid=%d, lock=%s)", e.PID, e.Path)
	}
	return fmt.Sprintf("pidfile is locked by another process (lock=%s): %v", e.Path, e.Err)
}

func (e *ErrLocked) Unwrap() error { return e.Err }
