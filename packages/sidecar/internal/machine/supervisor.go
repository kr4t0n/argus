package machine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/kr4t0n/argus/sidecar/internal/adapter"
	"github.com/kr4t0n/argus/sidecar/internal/bus"
	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// supervisor owns one running agent: an adapter instance, the goroutine
// reading the per-agent command stream, and the registration / heartbeat
// chatter on the shared lifecycle stream. Multiple supervisors run inside
// a single Daemon.
//
// supervisor is intentionally NOT exported — outside callers manipulate
// agents via Daemon.CreateAgent / Daemon.DestroyAgent.
type supervisor struct {
	spec    AgentRecord
	machine string // machine *id*, the parent's MachineID — for register events
	bus     *bus.Bus
	adapter adapter.Adapter
	version string // detected CLI version, "" if detection failed
	log     *log.Logger

	// serverURL + httpClient let the supervisor pull a turn's attachments
	// over HTTP from the server (the S3 gateway) before invoking the CLI.
	// serverURL is the same base the sidecar link / quota use; empty means
	// attachments are skipped (logged) rather than failing the turn.
	serverURL  string
	httpClient *http.Client

	cmdCancel context.CancelFunc
	doneCh    chan struct{}

	cancels sync.Map // commandID → context.CancelFunc
	busy    int64

	// Per-agent filesystem watcher. nil until run() starts it (and nil
	// again if the agent has no WorkingDir, or the watch itself failed
	// to register — in which case the tree works in manual-refresh
	// mode without live updates).
	fsw *fsWatcher

	// Per-agent git watcher (`.git/HEAD` + `refs/heads/`). Separate
	// from fsw because the primary watcher hard-skips `.git/` to
	// avoid object-write churn; this one is narrowly scoped just to
	// ref movement so the dashboard's commit panel can refresh on
	// commit/checkout/reset without us widening the primary watch.
	// Same fail-soft semantics as fsw — nil here just means the
	// panel falls back to mount-fetch + manual-refresh.
	gitw *gitWatcher

	// Per-agent progress watcher (.argus/progress/<id>.jsonl). Picks
	// up structured progress events written by argus-bg from the
	// shell and republishes them as BackgroundTask* lifecycle events
	// so the dashboard's per-project Progress tab can render live
	// status for detached background work. Same fail-soft semantics
	// as fsw / gitw — nil here means the tab stays empty.
	progw *progressWatcher
}

const (
	heartbeatInterval = 5 * time.Second
	cmdReadBlock      = 2 * time.Second
)

// newSupervisor builds (and `Ping`s) the adapter for an AgentRecord. It
// does NOT start the consume loop — the daemon does that via Start, so
// it can register the agent in its own bookkeeping atomically.
//
// Returns the partially-initialized supervisor on adapter construction
// failure as well, so the daemon can publish a spawn-failed event with
// rich context. Callers MUST check err before using sup.adapter.
func newSupervisor(
	ctx context.Context,
	machineID string,
	serverURL string,
	b *bus.Bus,
	spec AgentRecord,
	logger *log.Logger,
) (*supervisor, error) {
	adapterCfg := map[string]any{}
	for k, v := range spec.Adapter {
		adapterCfg[k] = v
	}
	if spec.WorkingDir != "" {
		adapterCfg[adapter.WorkingDirKey] = spec.WorkingDir
	}
	ad, err := adapter.New(spec.Type, adapterCfg)
	if err != nil {
		return nil, fmt.Errorf("build adapter: %w", err)
	}
	if err := ad.Ping(ctx); err != nil {
		// Non-fatal: keep going so the dashboard sees the agent
		// registered (in error state, ideally) instead of a silent
		// failure. handleCommand will surface a real error if the
		// CLI never recovers.
		logger.Printf("agent %s: adapter ping failed: %v (will keep running)", spec.AgentID, err)
	}

	version := ""
	if v, ok := ad.(adapter.Versioned); ok {
		if detected, verr := v.Version(ctx); verr == nil && detected != "" {
			version = detected
		} else if verr != nil {
			logger.Printf("agent %s: version detection failed: %v", spec.AgentID, verr)
		}
	}

	return &supervisor{
		spec:       spec,
		machine:    machineID,
		bus:        b,
		adapter:    ad,
		version:    version,
		log:        logger,
		serverURL:  serverURL,
		httpClient: &http.Client{Timeout: 2 * time.Minute},
		doneCh:     make(chan struct{}),
	}, nil
}

// Start kicks off the registration burst, the heartbeat loop, and the
// command consume loop in dedicated goroutines bound to ctx. Returns
// immediately. Callers stop the supervisor by either:
//   - cancelling parent ctx (graceful daemon shutdown)
//   - calling stop() (targeted destroy from a control command)
//
// stop() is the explicit path: it publishes a deregister event so the
// dashboard flips status without waiting for the heartbeat to lapse.
func (s *supervisor) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	s.cmdCancel = cancel
	go func() {
		defer close(s.doneCh)
		s.run(ctx)
	}()
}

// stop cancels the supervisor's context and waits for it to drain. Safe
// to call multiple times.
func (s *supervisor) stop() {
	if s.cmdCancel != nil {
		s.cmdCancel()
	}
	<-s.doneCh
}

func (s *supervisor) run(ctx context.Context) {
	if err := s.register(ctx); err != nil {
		s.log.Printf("agent %s: register failed: %v", s.spec.AgentID, err)
		// Continue anyway — heartbeats will eventually re-establish
		// the dashboard's view of the agent.
	}

	// The heartbeat loop and the command consume loop (below) are the
	// agent's critical paths; neither may be gated behind slow, best-effort
	// setup. newFSWatcher walks the workingDir and registers inotify
	// watches *synchronously*, which on a large tree takes many seconds —
	// long enough for the server's 30s sweeper (STALE_AFTER_MS) to mark a
	// freshly-registered agent offline, and (the bug this fixes) to delay
	// the consume loop so prompts just hang while the agent looks online.
	//
	// So: start heartbeats immediately, and bring the watchers up in the
	// background. The watcher goroutine also owns closing them on shutdown,
	// keeping s.fsw / s.gitw / s.progw touched from a single goroutine.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.heartbeatLoop(ctx)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		s.startFSWatcher(ctx)
		s.startGitWatcher(ctx)
		s.startProgressWatcher(ctx)
		<-ctx.Done()
		if s.fsw != nil {
			s.fsw.Close()
		}
		if s.gitw != nil {
			s.gitw.Close()
		}
		if s.progw != nil {
			s.progw.Close()
		}
	}()

	cmdStream := protocol.CommandStream(s.spec.AgentID)
	group := protocol.SidecarConsumerGroup(s.spec.AgentID)
	if err := s.bus.EnsureGroup(ctx, cmdStream, group); err != nil {
		s.log.Printf("agent %s: ensure group: %v", s.spec.AgentID, err)
	}

	consumer := "c-" + uuid.NewString()[:8]
	s.log.Printf("agent %s ready (type=%s)", s.spec.AgentID, s.spec.Type)

	for {
		if ctx.Err() != nil {
			break
		}
		msgID, payload, err := s.bus.ReadMessage(ctx, cmdStream, group, consumer, cmdReadBlock)
		if errors.Is(err, context.Canceled) {
			break
		}
		if err != nil {
			s.log.Printf("agent %s: read error: %v", s.spec.AgentID, err)
			time.Sleep(time.Second)
			continue
		}
		if msgID == "" {
			continue
		}

		cmd, err := decodeCommand(payload)
		if err != nil {
			s.log.Printf("agent %s: decode command: %v", s.spec.AgentID, err)
			_ = s.bus.Ack(ctx, cmdStream, group, msgID)
			continue
		}

		if cmd.Kind == "cancel" {
			if c, ok := s.cancels.Load(cmd.ID); ok {
				c.(context.CancelFunc)()
			}
			_ = s.adapter.Cancel(ctx, cmd.ID)
			_ = s.bus.Ack(ctx, cmdStream, group, msgID)
			continue
		}

		if cmd.Kind == "clone-session" {
			// Dispatch off the loop like execute: handleCloneSession copies
			// + rewrites the CLI's session JSONL synchronously, which would
			// otherwise stall the next command until the fork finishes.
			// Safe to run concurrently — the server gates prompting a forked
			// session on the session-external-id event this publishes.
			wg.Add(1)
			go func(c protocol.Command, id string) {
				defer wg.Done()
				s.handleCloneSession(ctx, c)
				_ = s.bus.Ack(ctx, cmdStream, group, id)
			}(cmd, msgID)
			continue
		}

		wg.Add(1)
		go func(c protocol.Command, id string) {
			defer wg.Done()
			s.handleCommand(ctx, c)
			_ = s.bus.Ack(ctx, cmdStream, group, id)
		}(cmd, msgID)
	}

	// Watchers are closed by their own goroutine on ctx.Done() (it owns
	// those fields); wg.Wait() below blocks until that has happened.

	// Best-effort deregister so the dashboard reflects the change
	// before our last heartbeat would have lapsed (~5s).
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = s.bus.Publish(shutdown, protocol.LifecycleStream(), protocol.DeregisterEvent{
		Kind: "deregister",
		ID:   s.spec.AgentID,
		TS:   time.Now().UnixMilli(),
	})

	wg.Wait()
}

func (s *supervisor) register(ctx context.Context) error {
	v := s.version
	if v == "" {
		v = "unknown"
	}
	return s.bus.Publish(ctx, protocol.LifecycleStream(), protocol.RegisterEvent{
		Kind:             "register",
		ID:               s.spec.AgentID,
		MachineID:        s.machine,
		Type:             s.spec.Type,
		SupportsTerminal: s.spec.SupportsTerminal,
		Version:          v,
		WorkingDir:       s.spec.WorkingDir,
		TS:               time.Now().UnixMilli(),
	})
}

func (s *supervisor) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(heartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			status := protocol.StatusOnline
			if atomic.LoadInt64(&s.busy) > 0 {
				status = protocol.StatusBusy
			}
			err := s.bus.Publish(ctx, protocol.LifecycleStream(), protocol.HeartbeatEvent{
				Kind:   "heartbeat",
				ID:     s.spec.AgentID,
				Status: status,
				TS:     time.Now().UnixMilli(),
			})
			if err != nil {
				s.log.Printf("agent %s: heartbeat publish failed: %v", s.spec.AgentID, err)
			}
		}
	}
}

// handleCloneSession runs a fork of the agent's CLI on-disk session
// state. Adapters opt in by implementing adapter.Cloner; if the agent's
// adapter doesn't (or the clone otherwise fails), we publish a
// SessionCloneFailedEvent so the dashboard can toast. A ResultChunk
// would be wrong here — the clone-session command has no Command row
// in the server DB, and a chunk insert would FK-violate against
// Command.id and get silently dropped.
//
// Successful clones emit a SessionExternalIDEvent on the result stream,
// which the server's result-ingestor consumes to set the new session's
// externalId — making future commands resume the cloned conversation.
func (s *supervisor) handleCloneSession(parent context.Context, cmd protocol.Command) {
	resultStream := protocol.ResultStream(s.spec.AgentID)
	publishErr := func(reason string) {
		_ = s.bus.Publish(parent, resultStream, protocol.SessionCloneFailedEvent{
			Kind:      "session-clone-failed",
			SessionID: cmd.SessionID,
			Reason:    reason,
			TS:        time.Now().UnixMilli(),
		})
	}

	if cmd.Clone == nil || cmd.Clone.SrcExternalID == "" {
		publishErr("clone-session command missing CloneSpec")
		return
	}
	cloner, ok := s.adapter.(adapter.Cloner)
	if !ok {
		publishErr(fmt.Sprintf("adapter %s does not support session cloning", s.spec.Type))
		return
	}
	newID, err := cloner.CloneSession(parent, cmd.Clone.SrcExternalID, cmd.Clone.TurnIndex)
	if err != nil {
		s.log.Printf("agent %s: clone-session failed: %v", s.spec.AgentID, err)
		publishErr(err.Error())
		return
	}
	if err := s.bus.Publish(parent, resultStream, protocol.SessionExternalIDEvent{
		Kind:       "session-external-id",
		SessionID:  cmd.SessionID,
		CommandID:  cmd.ID,
		ExternalID: newID,
		TS:         time.Now().UnixMilli(),
	}); err != nil {
		s.log.Printf("agent %s: clone-session publish external id failed: %v", s.spec.AgentID, err)
	}
}

func (s *supervisor) handleCommand(parent context.Context, cmd protocol.Command) {
	cmdCtx, cancel := context.WithCancel(parent)
	defer cancel()
	s.cancels.Store(cmd.ID, cancel)
	defer s.cancels.Delete(cmd.ID)
	atomic.AddInt64(&s.busy, 1)
	defer atomic.AddInt64(&s.busy, -1)

	resultStream := protocol.ResultStream(s.spec.AgentID)
	seq := 0
	publishExternalIDOnce := false

	// Pull + land any attached files BEFORE running the CLI. This sets
	// each ref's LocalPath and appends a path-listing preamble to the
	// prompt; adapters then reference the files (codex via --image, the
	// rest via the prompt path). Fail-soft: a bad pull is skipped, not
	// fatal to the turn.
	s.materializeAttachments(cmdCtx, &cmd)

	chunks, err := s.adapter.Execute(cmdCtx, cmd)
	if err != nil {
		seq++
		_ = s.bus.Publish(parent, resultStream, protocol.ResultChunk{
			ID:        uuid.NewString(),
			CommandID: cmd.ID,
			AgentID:   s.spec.AgentID,
			SessionID: cmd.SessionID,
			Seq:       seq,
			Kind:      protocol.KindError,
			Content:   err.Error(),
			TS:        time.Now().UnixMilli(),
			IsFinal:   true,
		})
		return
	}

	for c := range chunks {
		if !publishExternalIDOnce && c.ExternalID != "" {
			publishExternalIDOnce = true
			_ = s.bus.Publish(parent, resultStream, protocol.SessionExternalIDEvent{
				Kind:       "session-external-id",
				SessionID:  cmd.SessionID,
				CommandID:  cmd.ID,
				ExternalID: c.ExternalID,
				TS:         time.Now().UnixMilli(),
			})
		}
		seq++
		_ = s.bus.Publish(parent, resultStream, protocol.ResultChunk{
			ID:        uuid.NewString(),
			CommandID: cmd.ID,
			AgentID:   s.spec.AgentID,
			SessionID: cmd.SessionID,
			Seq:       seq,
			Kind:      c.Kind,
			Delta:     c.Delta,
			Content:   c.Content,
			Meta:      c.Meta,
			TS:        time.Now().UnixMilli(),
			IsFinal:   c.IsFinal,
		})
	}
}

// startFSWatcher brings up the per-agent recursive file watcher if the
// agent has a workingDir. Failures are logged and ignored — the tree
// UI degrades to manual refresh but otherwise keeps working.
func (s *supervisor) startFSWatcher(ctx context.Context) {
	if s.spec.WorkingDir == "" {
		return
	}
	w, err := newFSWatcher(ctx, s.spec.WorkingDir, func(relDir string) {
		_ = s.bus.Publish(ctx, protocol.LifecycleStream(), protocol.FSChangedEvent{
			Kind:      "fs-changed",
			MachineID: s.machine,
			AgentID:   s.spec.AgentID,
			Path:      relDir,
			TS:        time.Now().UnixMilli(),
		})
	}, s.log)
	if err != nil {
		s.log.Printf("agent %s: fs watcher disabled: %v", s.spec.AgentID, err)
		return
	}
	s.fsw = w
}

// startGitWatcher brings up the per-agent ref watcher (`.git/HEAD` +
// `refs/heads/`) so the dashboard's commit panel can refresh on
// commits / checkouts / resets without polling. Non-repos and watch
// failures degrade silently to manual-refresh, matching fsw.
func (s *supervisor) startGitWatcher(ctx context.Context) {
	if s.spec.WorkingDir == "" {
		return
	}
	w, err := newGitWatcher(ctx, s.spec.WorkingDir, func() {
		_ = s.bus.Publish(ctx, protocol.LifecycleStream(), protocol.GitChangedEvent{
			Kind:      "git-changed",
			MachineID: s.machine,
			AgentID:   s.spec.AgentID,
			TS:        time.Now().UnixMilli(),
		})
	}, s.log)
	if err != nil {
		s.log.Printf("agent %s: git watcher disabled: %v", s.spec.AgentID, err)
		return
	}
	// Non-repo workingDir returns (nil, nil) — quiet, expected.
	if w == nil {
		return
	}
	s.gitw = w
}

// startProgressWatcher brings up the per-agent argus-bg JSONL tailer
// so background-task progress lands on the lifecycle stream. The
// callback maps each decoded bgEvent to its BackgroundTask* protocol
// shape, attaching machineId / agentId / workingDir from the
// supervisor's spec. Failures (missing workingDir, MkdirAll denied,
// fsnotify out of inotify watches) downgrade silently — the rest of
// the agent keeps running.
func (s *supervisor) startProgressWatcher(ctx context.Context) {
	if s.spec.WorkingDir == "" {
		return
	}
	w, err := newProgressWatcher(ctx, s.spec.WorkingDir, func(ev bgEvent) {
		s.publishBackgroundTaskEvent(ctx, ev)
	}, s.log)
	if err != nil {
		s.log.Printf("agent %s: progress watcher disabled: %v", s.spec.AgentID, err)
		return
	}
	s.progw = w
}

// publishBackgroundTaskEvent turns one bgEvent (the JSONL wire format
// argus-bg writes) into the matching protocol event and publishes it
// on the lifecycle stream. Unknown event types are dropped silently
// — newer argus-bg versions might emit kinds this supervisor doesn't
// recognize, and we don't want one stray line to surface as noise.
func (s *supervisor) publishBackgroundTaskEvent(ctx context.Context, ev bgEvent) {
	now := time.Now().UnixMilli()
	switch ev.Type {
	case "start":
		_ = s.bus.Publish(ctx, protocol.BackgroundTaskStream(), protocol.BackgroundTaskStartedEvent{
			Kind:       "background-task-started",
			MachineID:  s.machine,
			AgentID:    s.spec.AgentID,
			WorkingDir: s.spec.WorkingDir,
			TaskID:     ev.ID,
			Label:      ev.Label,
			Cmd:        ev.Cmd,
			PID:        ev.PID,
			StartedAt:  ev.StartedAt,
			TS:         now,
		})
	case "progress":
		_ = s.bus.Publish(ctx, protocol.BackgroundTaskStream(), protocol.BackgroundTaskProgressEvent{
			Kind:       "background-task-progress",
			MachineID:  s.machine,
			AgentID:    s.spec.AgentID,
			WorkingDir: s.spec.WorkingDir,
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
		_ = s.bus.Publish(ctx, protocol.BackgroundTaskStream(), protocol.BackgroundTaskEndedEvent{
			Kind:       "background-task-ended",
			MachineID:  s.machine,
			AgentID:    s.spec.AgentID,
			WorkingDir: s.spec.WorkingDir,
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

// HandleFSList executes a list-directory request for this agent and
// publishes the response back on the lifecycle stream. When req.Depth
// > 1 the reply carries every listing up to that depth in Listings so
// the dashboard can hydrate its tree cache in a single round trip.
// Entries always carries the requested path's listing so clients that
// don't consume Listings keep working.
func (s *supervisor) HandleFSList(ctx context.Context, req protocol.FSListRequestCommand) {
	resp := protocol.FSListResponseEvent{
		Kind:      "fs-list-response",
		MachineID: s.machine,
		AgentID:   s.spec.AgentID,
		RequestID: req.RequestID,
		Path:      req.Path,
		TS:        time.Now().UnixMilli(),
	}

	depth := req.Depth
	if depth < 1 {
		depth = 1
	}
	// Match ListDirs' root-path normalization so the root-listing
	// lookup below hits the canonical "" key it produces.
	rootKey := req.Path
	if rootKey == "." {
		rootKey = ""
	}
	listings, err := ListDirs(ListDirRequest{
		WorkingDir: s.spec.WorkingDir,
		Path:       req.Path,
		ShowAll:    req.ShowAll,
	}, depth, protocol.FSListRecursiveDescentBudget)

	if err != nil {
		resp.Error = err.Error()
	} else {
		if depth > 1 {
			resp.Listings = make(map[string][]protocol.FSEntry, len(listings))
		}
		for path, entries := range listings {
			pe := toProtocolEntries(entries)
			if path == rootKey {
				resp.Entries = pe
			}
			if depth > 1 {
				resp.Listings[path] = pe
			}
		}
		s.attachGit(&resp)
	}

	if err := s.bus.Publish(ctx, protocol.LifecycleStream(), resp); err != nil {
		s.log.Printf("agent %s: fs-list-response publish failed: %v", s.spec.AgentID, err)
	}
}

// attachGit best-effort fills resp.Git. Non-repo workingDirs return
// (nil, nil) and silently no-op; real errors are logged but not fatal.
func (s *supervisor) attachGit(resp *protocol.FSListResponseEvent) {
	git, err := ReadGitStatus(s.spec.WorkingDir)
	if err != nil {
		s.log.Printf("agent %s: read git status: %v", s.spec.AgentID, err)
		return
	}
	if git != nil {
		resp.Git = git
	}
}

func toProtocolEntries(entries []FSEntry) []protocol.FSEntry {
	out := make([]protocol.FSEntry, len(entries))
	for i, e := range entries {
		out[i] = protocol.FSEntry{
			Name:       e.Name,
			Kind:       e.Kind,
			Size:       e.Size,
			MTime:      e.MTime,
			Gitignored: e.Gitignored,
		}
	}
	return out
}

// HandleFSRead executes a file-read request for this agent and
// publishes the response back on the lifecycle stream. Mirrors
// HandleFSList — same workingDir jail, same fire-and-forget reply
// path. Hard errors (missing file, path escape, I/O) become
// Result="error" so the dashboard always gets a structured reply
// within the server's timeout window.
func (s *supervisor) HandleFSRead(ctx context.Context, req protocol.FSReadRequestCommand) {
	res, err := ReadFile(ReadFileRequest{
		WorkingDir: s.spec.WorkingDir,
		Path:       req.Path,
		MaxBytes:   protocol.FSReadMaxBytes,
	})
	resp := protocol.FSReadResponseEvent{
		Kind:      "fs-read-response",
		MachineID: s.machine,
		AgentID:   s.spec.AgentID,
		RequestID: req.RequestID,
		Path:      req.Path,
		TS:        time.Now().UnixMilli(),
	}
	if err != nil {
		resp.Result = "error"
		resp.Error = err.Error()
	} else {
		resp.Result = res.Result
		resp.Content = res.Content
		resp.MIME = res.MIME
		resp.Base64 = res.Base64
		resp.Size = res.Size
		resp.Error = res.Error
	}
	if err := s.bus.Publish(ctx, protocol.LifecycleStream(), resp); err != nil {
		s.log.Printf("agent %s: fs-read-response publish failed: %v", s.spec.AgentID, err)
	}
}

// HandleGitLog runs `git log` in the agent's workingDir and publishes
// the recent commits back on the lifecycle stream. Same fan-in
// pattern as HandleFSList — keyed by RequestID for the server to
// match against its pending-promise map. Errors (non-repo, git not
// on PATH, exec failure) are surfaced as Error so the dashboard
// renders a panel-level error instead of timing out.
func (s *supervisor) HandleGitLog(ctx context.Context, req protocol.GitLogRequestCommand) {
	resp := protocol.GitLogResponseEvent{
		Kind:      "git-log-response",
		MachineID: s.machine,
		AgentID:   s.spec.AgentID,
		RequestID: req.RequestID,
		TS:        time.Now().UnixMilli(),
	}
	commits, err := ReadGitLog(ctx, s.spec.WorkingDir, req.Limit)
	if err != nil {
		resp.Error = err.Error()
	} else {
		// commits == nil ⇒ non-repo workingDir. The server treats nil
		// the same as an empty list at the controller layer, so callers
		// see "no commits" rather than an error. We could also return
		// an explicit error here, but rendering an empty list keeps the
		// panel flicker-free if the user toggles into a non-repo dir.
		resp.Commits = commits
	}
	// Attach GitStatus regardless — even when log read failed, the
	// panel header might still want to display the current branch.
	// Cheap: ReadGitStatus is one .git/HEAD read.
	if status, gerr := ReadGitStatus(s.spec.WorkingDir); gerr == nil && status != nil {
		resp.Git = status
	}
	if err := s.bus.Publish(ctx, protocol.LifecycleStream(), resp); err != nil {
		s.log.Printf("agent %s: git-log-response publish failed: %v", s.spec.AgentID, err)
	}
}

func decodeCommand(payload map[string]any) (protocol.Command, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return protocol.Command{}, err
	}
	var c protocol.Command
	if err := json.Unmarshal(b, &c); err != nil {
		return protocol.Command{}, err
	}
	return c, nil
}
