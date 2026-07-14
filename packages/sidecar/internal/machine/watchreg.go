// Package machine — per-workdir watcher registry.
//
// Phase 3 of docs/plan-agent-to-runners.md moves the fs / git / progress
// watchers off the per-agent supervisors onto a single registry keyed by
// workdir, driven by the server's sync-projects allowlist. One watcher
// trio per project directory kills the old duplicate inotify watches
// (two agents sharing a workdir used to double every fs-changed /
// background-task event).
//
// Events carry WorkingDir with AgentID empty — the protocol documents
// agentId as attribution-only on these shapes (see FSChangedEvent /
// GitChangedEvent / the background-task section in protocol.go), and the
// server's project-room fanout (Phase 2) routes on workingDir.
package machine

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/bus"
	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// watchRegistry owns one watcher set (fs + git + progress) per
// allowlisted workdir. Reconcile is the only mutation surface: it
// diffs the desired set against what's running, starts watchers for
// new dirs, and closes watchers for removed ones.
type watchRegistry struct {
	machine string
	bus     *bus.Bus
	log     *log.Logger

	mu   sync.Mutex
	sets map[string]*watcherSet // workdir → running set
}

// watcherSet is the running trio for one workdir. cancel tears the set
// down; the bring-up goroutine owns the watcher handles and closes them
// on ctx.Done(), so the fields are touched from a single goroutine —
// same ownership model the supervisors used.
type watcherSet struct {
	cancel context.CancelFunc
}

func newWatchRegistry(machineID string, b *bus.Bus, logger *log.Logger) *watchRegistry {
	return &watchRegistry{
		machine: machineID,
		bus:     b,
		log:     logger,
		sets:    make(map[string]*watcherSet),
	}
}

// Reconcile brings the running watcher sets in line with `workdirs`:
// new dirs get a set started, removed dirs get theirs cancelled. The
// snapshot is idempotent — re-sending the same allowlist is a no-op.
// ctx should be the daemon's run context so a daemon shutdown tears
// every set down without an explicit Close.
func (wr *watchRegistry) Reconcile(ctx context.Context, workdirs []string) {
	want := make(map[string]struct{}, len(workdirs))
	for _, wd := range workdirs {
		if wd == "" {
			continue
		}
		want[wd] = struct{}{}
	}

	wr.mu.Lock()
	var stop []*watcherSet
	for wd, set := range wr.sets {
		if _, keep := want[wd]; !keep {
			stop = append(stop, set)
			delete(wr.sets, wd)
		}
	}
	var start []string
	for wd := range want {
		if _, running := wr.sets[wd]; !running {
			setCtx, cancel := context.WithCancel(ctx)
			wr.sets[wd] = &watcherSet{cancel: cancel}
			start = append(start, wd)
			go wr.runSet(setCtx, wd)
		}
	}
	wr.mu.Unlock()

	for _, set := range stop {
		set.cancel()
	}
	if len(start) > 0 || len(stop) > 0 {
		wr.log.Printf("watchers: reconciled to %d workdir(s) (+%d/-%d)", len(want), len(start), len(stop))
	}
}

// runSet brings up (and eventually closes) the watcher trio for one
// workdir. Startup is deliberately async off Reconcile's caller:
// newFSWatcher walks the workingDir and registers inotify watches
// *synchronously*, which on a large tree takes many seconds — long
// enough to stall the control loop that dispatched the sync-projects
// command (the same rationale the supervisors had for backgrounding
// watcher bring-up off their command path). Each watcher fails soft:
// a nil handle just means that panel degrades to manual refresh.
func (wr *watchRegistry) runSet(ctx context.Context, workdir string) {
	fsw := wr.startFSWatcher(ctx, workdir)
	gitw := wr.startGitWatcher(ctx, workdir)
	progw := wr.startProgressWatcher(ctx, workdir)

	<-ctx.Done()
	if fsw != nil {
		fsw.Close()
	}
	if gitw != nil {
		gitw.Close()
	}
	if progw != nil {
		progw.Close()
	}
}

// startFSWatcher brings up the recursive file watcher for one workdir.
// Failures are logged and ignored — the tree UI degrades to manual
// refresh but otherwise keeps working.
func (wr *watchRegistry) startFSWatcher(ctx context.Context, workdir string) *fsWatcher {
	w, err := newFSWatcher(ctx, workdir, func(relDir string) {
		_ = wr.bus.Publish(ctx, protocol.NotifyStream(), protocol.FSChangedEvent{
			Kind:       "fs-changed",
			MachineID:  wr.machine,
			AgentID:    "", // attribution only; the server routes on workingDir
			WorkingDir: workdir,
			Path:       relDir,
			TS:         time.Now().UnixMilli(),
		})
	}, wr.log)
	if err != nil {
		wr.log.Printf("watchers %s: fs watcher disabled: %v", workdir, err)
		return nil
	}
	return w
}

// startGitWatcher brings up the ref watcher (`.git/HEAD` +
// `refs/heads/`) so the dashboard's commit panel can refresh on
// commits / checkouts / resets without polling. Non-repos and watch
// failures degrade silently to manual-refresh, matching fsw.
func (wr *watchRegistry) startGitWatcher(ctx context.Context, workdir string) *gitWatcher {
	w, err := newGitWatcher(ctx, workdir, func() {
		_ = wr.bus.Publish(ctx, protocol.NotifyStream(), protocol.GitChangedEvent{
			Kind:       "git-changed",
			MachineID:  wr.machine,
			AgentID:    "", // attribution only; the server routes on workingDir
			WorkingDir: workdir,
			TS:         time.Now().UnixMilli(),
		})
	}, wr.log)
	if err != nil {
		wr.log.Printf("watchers %s: git watcher disabled: %v", workdir, err)
		return nil
	}
	// Non-repo workingDir returns (nil, nil) — quiet, expected.
	return w
}

// startProgressWatcher brings up the argus-bg JSONL tailer for one
// workdir so background-task progress lands on the background stream.
// Failures (MkdirAll denied, fsnotify out of inotify watches) downgrade
// silently — the Progress tab stays empty, everything else runs.
func (wr *watchRegistry) startProgressWatcher(ctx context.Context, workdir string) *progressWatcher {
	w, err := newProgressWatcher(ctx, workdir, func(ev bgEvent) {
		publishBackgroundTaskEvent(ctx, wr.bus, wr.machine, workdir, ev)
	}, wr.log)
	if err != nil {
		wr.log.Printf("watchers %s: progress watcher disabled: %v", workdir, err)
		return nil
	}
	return w
}

// publishBackgroundTaskEvent turns one bgEvent (the JSONL wire format
// argus-bg writes) into the matching protocol event and publishes it
// on the background stream. Unknown event types are dropped silently
// — newer argus-bg versions might emit kinds this sidecar doesn't
// recognize, and we don't want one stray line to surface as noise.
//
// AgentID is empty: the events are scoped by (machineId, workingDir,
// taskId) and the protocol documents agentId as attribution-only.
func publishBackgroundTaskEvent(ctx context.Context, b *bus.Bus, machineID, workingDir string, ev bgEvent) {
	now := time.Now().UnixMilli()
	switch ev.Type {
	case "start":
		_ = b.Publish(ctx, protocol.BackgroundTaskStream(), protocol.BackgroundTaskStartedEvent{
			Kind:       "background-task-started",
			MachineID:  machineID,
			AgentID:    "",
			WorkingDir: workingDir,
			TaskID:     ev.ID,
			Label:      ev.Label,
			Cmd:        ev.Cmd,
			PID:        ev.PID,
			StartedAt:  ev.StartedAt,
			TS:         now,
		})
	case "progress":
		_ = b.Publish(ctx, protocol.BackgroundTaskStream(), protocol.BackgroundTaskProgressEvent{
			Kind:       "background-task-progress",
			MachineID:  machineID,
			AgentID:    "",
			WorkingDir: workingDir,
			TaskID:     ev.ID,
			Label:      ev.Label,
			Cmd:        ev.Cmd,
			Current:    ev.Current,
			Total:      ev.Total,
			Percent:    ev.Percent,
			EtaSeconds: ev.EtaSeconds,
			Rate:       ev.Rate,
			Unit:       ev.Unit,
			Desc:       ev.Desc,
			TS:         now,
		})
	case "end":
		_ = b.Publish(ctx, protocol.BackgroundTaskStream(), protocol.BackgroundTaskEndedEvent{
			Kind:       "background-task-ended",
			MachineID:  machineID,
			AgentID:    "",
			WorkingDir: workingDir,
			TaskID:     ev.ID,
			Label:      ev.Label,
			Cmd:        ev.Cmd,
			ExitCode:   ev.ExitCode,
			Status:     ev.Status,
			EndedAt:    ev.EndedAt,
			TS:         now,
		})
	}
}
