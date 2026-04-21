package machine

import (
	"context"
	"errors"
	"log"
	"os"
	"sync"
	"time"

	"github.com/kyley/argus/sidecar/internal/protocol"
	"github.com/kyley/argus/sidecar/internal/updater"
)

// RestartMode describes how the sidecar will swap to the freshly
// installed binary. The choice is reported on the wire so the
// dashboard can render accurate copy ("restarting now…" vs. "please
// restart manually").
//
//   - RestartSelf — the sidecar was launched detached by
//     `argus-sidecar start` (background mode). After publishing
//     `downloaded`, the daemon does syscall.Exec on the same binary
//     path, which atomically swaps to the new bytes (the post-rename
//     inode) while keeping the pidfile lock alive (flock survives
//     exec(2)).
//   - RestartSupervisor — the sidecar is running under
//     systemd/launchd. We exit(0) and let the supervisor's restart
//     policy bring us back up. Same effect, different responsible
//     party.
//   - RestartManual — the sidecar is in the foreground attached to
//     a TTY. We deliberately do NOT auto-restart (would yank the
//     interactive terminal output mid-session). The dashboard
//     surfaces the restart-needed copy and the operator restarts at
//     their convenience.
const (
	RestartSelf       = "self"
	RestartSupervisor = "supervisor"
	RestartManual     = "manual"
)

// UpdateState owns the in-flight update bookkeeping. Lives on the
// Daemon. Single-flight: a second update-sidecar arriving while one is
// running is rejected with a synthetic failed event so the dashboard
// doesn't think it was lost. Bulk updates already serialize at the
// server, but this also protects against a stuck batch + manual click
// race.
type UpdateState struct {
	mu          sync.Mutex
	inFlight    bool
	restartMode string // "" until handleUpdate decides
}

// detectRestartMode picks one of the three RestartMode constants based
// on environment hints. Run once per update at decision time rather
// than at boot so a sidecar that has been backgrounded mid-life (e.g.
// disowned from a shell) still reports correctly. Detection rules:
//
//   - systemd / launchd set well-known env vars on their children.
//     INVOCATION_ID is a stable systemd marker (since v232);
//     NOTIFY_SOCKET is set when Type=notify; XPC_SERVICE_NAME is set
//     for launchd jobs.
//   - Otherwise, check for a controlling TTY on stdin/stderr. A
//     daemonized child of `argus-sidecar start` has neither (we
//     dup2'd /dev/null + the log file), so absence ⇒ background.
//   - Anything else ⇒ foreground TTY ⇒ manual.
func detectRestartMode() string {
	for _, k := range []string{
		"INVOCATION_ID",
		"NOTIFY_SOCKET",
		"XPC_SERVICE_NAME",
	} {
		if os.Getenv(k) != "" {
			return RestartSupervisor
		}
	}
	if isCharDevice(os.Stdin) || isCharDevice(os.Stderr) {
		return RestartManual
	}
	return RestartSelf
}

func isCharDevice(f *os.File) bool {
	st, err := f.Stat()
	if err != nil {
		return false
	}
	return (st.Mode() & os.ModeCharDevice) != 0
}

// handleUpdateSidecar is the core update flow. Called from
// dispatchControl; runs synchronously on the control loop goroutine
// so we don't accept further commands while a swap is in flight.
//
// The state machine:
//
//	started → updater.Update() → downloaded → request shutdown.
//
// On any error we publish failed and bail without touching the
// running binary or pidfile (updater.Update already cleans its temp
// file on every error path).
func (d *Daemon) handleUpdateSidecar(ctx context.Context, req protocol.UpdateSidecarCommand) {
	state := d.update
	state.mu.Lock()
	if state.inFlight {
		state.mu.Unlock()
		d.publishUpdateFailed(ctx, req.RequestID, "another update is already in progress on this machine")
		return
	}
	state.inFlight = true
	state.mu.Unlock()
	defer func() {
		state.mu.Lock()
		state.inFlight = false
		state.mu.Unlock()
	}()

	d.log.Printf("update-sidecar: requestId=%s starting from %s", req.RequestID, d.sidecarVersion)
	d.publishUpdateStarted(ctx, req.RequestID)

	// Surface updater output into the daemon log so a tail of
	// sidecar.log is enough to debug a failed remote update.
	uplog := log.New(d.log.Writer(), "[updater] ", log.LstdFlags|log.Lmicroseconds)

	// Use a generous standalone context: the GitHub API + asset
	// download can take ~30s on a slow link and we don't want a
	// transient bus hiccup (which cancels the parent ctx via the
	// daemon shutdown path) to abort a partly-downloaded swap.
	updCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	tag, err := updater.Update(updCtx, updater.Options{
		// Always pin to the canonical repo for remote-triggered
		// updates. Letting the dashboard pick a custom repo would
		// be a hostile-server escalation path; the local CLI
		// `argus-sidecar update --repo` still exists for ops folks
		// who need to point at a fork.
		Repo:           updater.DefaultRepo,
		CurrentVersion: d.sidecarVersion,
		Logger:         uplog,
	})
	if err != nil {
		d.log.Printf("update-sidecar: updater.Update failed: %v", err)
		d.publishUpdateFailed(ctx, req.RequestID, err.Error())
		return
	}
	if tag == d.sidecarVersion {
		// Already current — nothing was swapped, so don't restart.
		// The server's bulk-update path filters these out via
		// the version check, but a stale dashboard could still
		// click the per-machine button. Treat as a no-op success.
		d.log.Printf("update-sidecar: already on %s, nothing to do", tag)
		d.publishUpdateDownloaded(ctx, req.RequestID, tag, RestartManual)
		return
	}

	mode := detectRestartMode()
	d.log.Printf("update-sidecar: swapped to %s, restartMode=%s", tag, mode)
	d.publishUpdateDownloaded(ctx, req.RequestID, tag, mode)

	if mode == RestartManual {
		// Stay running on the old in-memory image. The next
		// foreground invocation picks up the new bytes.
		return
	}

	// Hand off to the restart path: store the desired mode and
	// cancel the daemon ctx so Run() returns. main.go inspects
	// d.RestartMode() and either syscall.Exec's (self) or just
	// exits 0 (supervisor).
	state.mu.Lock()
	state.restartMode = mode
	state.mu.Unlock()
	d.requestShutdown()
}

// RestartMode returns the post-shutdown restart action, if any.
// Empty string means "no restart, exit normally" (the regular
// SIGTERM path). Called by main.go after Run() returns.
func (d *Daemon) RestartMode() string {
	d.update.mu.Lock()
	defer d.update.mu.Unlock()
	return d.update.restartMode
}

// requestShutdown is the daemon's internal "please exit" hook used
// by paths that want to terminate the main loop without sending a
// signal (e.g. self-update). Idempotent; cancels the run context
// installed by Run().
func (d *Daemon) requestShutdown() {
	d.cancelMu.Lock()
	cancel := d.runCancel
	d.cancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (d *Daemon) publishUpdateStarted(ctx context.Context, requestID string) {
	if err := d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.SidecarUpdateStartedEvent{
		Kind:        "sidecar-update-started",
		MachineID:   d.cache.MachineID,
		RequestID:   requestID,
		FromVersion: d.sidecarVersion,
		TS:          time.Now().UnixMilli(),
	}); err != nil && !errors.Is(err, context.Canceled) {
		d.log.Printf("update-sidecar: publish started: %v", err)
	}
}

func (d *Daemon) publishUpdateDownloaded(ctx context.Context, requestID, toVersion, mode string) {
	if err := d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.SidecarUpdateDownloadedEvent{
		Kind:        "sidecar-update-downloaded",
		MachineID:   d.cache.MachineID,
		RequestID:   requestID,
		FromVersion: d.sidecarVersion,
		ToVersion:   toVersion,
		RestartMode: mode,
		TS:          time.Now().UnixMilli(),
	}); err != nil && !errors.Is(err, context.Canceled) {
		d.log.Printf("update-sidecar: publish downloaded: %v", err)
	}
}

func (d *Daemon) publishUpdateFailed(ctx context.Context, requestID, reason string) {
	if err := d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.SidecarUpdateFailedEvent{
		Kind:        "sidecar-update-failed",
		MachineID:   d.cache.MachineID,
		RequestID:   requestID,
		FromVersion: d.sidecarVersion,
		Reason:      reason,
		TS:          time.Now().UnixMilli(),
	}); err != nil && !errors.Is(err, context.Canceled) {
		d.log.Printf("update-sidecar: publish failed: %v", err)
	}
}
