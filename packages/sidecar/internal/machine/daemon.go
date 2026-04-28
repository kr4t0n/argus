package machine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/kr4t0n/argus/sidecar/internal/bus"
	"github.com/kr4t0n/argus/sidecar/internal/protocol"
	"github.com/kr4t0n/argus/sidecar/internal/sidecarlink"
	"github.com/kr4t0n/argus/sidecar/internal/terminal"
)

const (
	machineHeartbeatInterval = 5 * time.Second
	controlReadBlock         = 2 * time.Second
	// fsConcurrencyLimit caps how many fs-list / fs-read handlers run
	// in parallel across all agents. Picked empirically: high enough
	// that a tree refresh of ~20 expanded folders drains in parallel
	// instead of serializing through the control loop, low enough
	// that a malicious or buggy client can't fork-bomb the disk.
	// Goroutines that don't get a slot just queue at the channel
	// send — no requests are dropped.
	fsConcurrencyLimit = 16
)

// Daemon is the long-lived per-machine process. It owns a single bus
// connection, a single sidecar↔server link (lazy: only spun up if any
// agent has supportsTerminal), and a set of agent supervisors keyed by
// agentId.
//
// The cache is the source of truth across daemon restarts: on boot we
// spawn supervisors from the cached set immediately (so dashboard users
// don't see a blank machine while the server reconciles), then a
// SyncAgentsCommand from the server reconciles any drift that happened
// while we were offline.
type Daemon struct {
	cachePath      string
	cache          *Cache
	sidecarVersion string
	bus            *bus.Bus
	link           *sidecarlink.Client // nil unless any agent has supportsTerminal
	terminals      *terminal.Runner    // nil unless link is up
	log            *log.Logger

	mu          sync.Mutex
	supervisors map[string]*supervisor // agentID → supervisor

	// availableAdapters captured once at boot; the dashboard reads this
	// to decide which adapter types to offer in the create-agent UI.
	availableAdapters []protocol.AvailableAdapter
	hostname          string

	// Remote-update bookkeeping. update gates concurrent updates and
	// tracks the post-shutdown restart action; runCancel is the
	// installed cancel func for the run-scoped ctx so the update
	// handler can ask the main loop to exit without spoofing a signal.
	update    *UpdateState
	cancelMu  sync.Mutex
	runCancel context.CancelFunc

	// Bounded-concurrency gate for fs-list / fs-read handlers. A
	// depth-N fs-list can walk thousands of directory entries; if we
	// ran it on the control goroutine, a tree refresh with multiple
	// expansions serialized past the server's 5 s fs-list timeout.
	// Send blocks when full so excess requests queue rather than drop.
	fsSlots chan struct{}
}

// New builds a Daemon from a loaded cache and version string. Does NOT
// dial the bus or start any goroutines — call Run for that.
func New(cachePath string, cache *Cache, sidecarVersion string, logger *log.Logger) *Daemon {
	hn, _ := os.Hostname()
	return &Daemon{
		cachePath:      cachePath,
		cache:          cache,
		sidecarVersion: sidecarVersion,
		log:            logger,
		supervisors:    make(map[string]*supervisor),
		hostname:       hn,
		update:         &UpdateState{},
		fsSlots:        make(chan struct{}, fsConcurrencyLimit),
	}
}

// Lookup implements terminal.AgentLookup so the terminal runner can ask
// the daemon for an agent's working dir / opt-in state without taking a
// dependency on the supervisor type itself.
func (d *Daemon) Lookup(agentID string) (terminal.AgentInfo, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s, ok := d.supervisors[agentID]
	if !ok {
		return terminal.AgentInfo{}, false
	}
	return terminal.AgentInfo{
		SupportsTerminal: s.spec.SupportsTerminal,
		WorkingDir:       s.spec.WorkingDir,
	}, true
}

// Run is the daemon main loop. Blocks until ctx is cancelled.
func (d *Daemon) Run(ctx context.Context) error {
	// Install a child cancel so internal paths (e.g. self-update)
	// can ask for a clean shutdown without sending a signal. The
	// parent ctx (driven by SIGTERM) still propagates here.
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	d.cancelMu.Lock()
	d.runCancel = cancel
	d.cancelMu.Unlock()
	ctx = runCtx

	b, err := bus.Dial(ctx, d.cache.Bus)
	if err != nil {
		return fmt.Errorf("bus dial: %w", err)
	}
	d.bus = b
	defer b.Close()

	d.availableAdapters = Discover(ctx)
	d.log.Printf("discovery: found %d adapter(s) on PATH", len(d.availableAdapters))
	for _, a := range d.availableAdapters {
		d.log.Printf("  - %s @ %s (version=%q)", a.Type, a.Binary, a.Version)
	}

	if err := d.publishMachineRegister(ctx); err != nil {
		d.log.Printf("machine-register publish failed: %v (will retry via heartbeat)", err)
	}

	controlStream := protocol.MachineControlStream(d.cache.MachineID)
	controlGroup := protocol.MachineConsumerGroup(d.cache.MachineID)
	if err := d.bus.EnsureGroup(ctx, controlStream, controlGroup); err != nil {
		return fmt.Errorf("ensure control group: %w", err)
	}

	for _, rec := range d.cache.Agents {
		d.spawnSupervisor(ctx, rec, false)
	}

	d.maybeStartTerminalLink(ctx)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		d.machineHeartbeatLoop(ctx)
	}()

	consumer := "c-" + uuid.NewString()[:8]
	d.log.Printf("machine ready id=%s name=%s agents=%d",
		d.cache.MachineID, d.cache.Name, len(d.supervisors))

	for {
		if ctx.Err() != nil {
			break
		}
		msgID, payload, err := d.bus.ReadMessage(ctx, controlStream, controlGroup, consumer, controlReadBlock)
		if errors.Is(err, context.Canceled) {
			break
		}
		if err != nil {
			d.log.Printf("control read error: %v", err)
			time.Sleep(time.Second)
			continue
		}
		if msgID == "" {
			continue
		}
		d.dispatchControl(ctx, payload)
		_ = d.bus.Ack(ctx, controlStream, controlGroup, msgID)
	}

	d.shutdownAllSupervisors()
	wg.Wait()
	return nil
}

func (d *Daemon) publishMachineRegister(ctx context.Context) error {
	return d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.MachineRegisterEvent{
		Kind:              "machine-register",
		MachineID:         d.cache.MachineID,
		Name:              d.cache.Name,
		Hostname:          d.hostname,
		OS:                runtime.GOOS,
		Arch:              runtime.GOARCH,
		SidecarVersion:    d.sidecarVersion,
		AvailableAdapters: d.availableAdapters,
		TS:                time.Now().UnixMilli(),
	})
}

func (d *Daemon) machineHeartbeatLoop(ctx context.Context) {
	t := time.NewTicker(machineHeartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			err := d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.MachineHeartbeatEvent{
				Kind:      "machine-heartbeat",
				MachineID: d.cache.MachineID,
				TS:        time.Now().UnixMilli(),
			})
			if err != nil {
				d.log.Printf("machine-heartbeat publish failed: %v", err)
			}
		}
	}
}

// dispatchControl decodes a single control message and routes it to the
// matching handler. We discriminate by `kind` so adding new commands is
// just a new case.
func (d *Daemon) dispatchControl(ctx context.Context, payload map[string]any) {
	kindStr, _ := payload["kind"].(string)
	switch kindStr {
	case "create-agent":
		var ev protocol.CreateAgentCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad create-agent: %v", err)
			return
		}
		d.handleCreateAgent(ctx, ev.Agent)
	case "destroy-agent":
		var ev protocol.DestroyAgentCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad destroy-agent: %v", err)
			return
		}
		d.handleDestroyAgent(ctx, ev.AgentID)
	case "sync-agents":
		var ev protocol.SyncAgentsCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad sync-agents: %v", err)
			return
		}
		d.handleSyncAgents(ctx, ev.Agents)
	case "fs-list":
		var ev protocol.FSListRequestCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad fs-list: %v", err)
			return
		}
		d.handleFSList(ctx, ev)
	case "fs-read":
		var ev protocol.FSReadRequestCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad fs-read: %v", err)
			return
		}
		d.handleFSRead(ctx, ev)
	case "git-log":
		var ev protocol.GitLogRequestCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad git-log: %v", err)
			return
		}
		d.handleGitLog(ctx, ev)
	case "update-sidecar":
		var ev protocol.UpdateSidecarCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad update-sidecar: %v", err)
			return
		}
		d.handleUpdateSidecar(ctx, ev)
	default:
		d.log.Printf("control: unknown kind=%q", kindStr)
	}
}

// handleFSList routes an fs-list request to the target agent's
// supervisor. If the agent is unknown (race: deleted between server
// publish and sidecar read) we publish a synthetic error response so
// the server-side pending request resolves instead of timing out.
//
// The actual listing runs in a goroutine bounded by fsSlots so the
// control loop returns immediately. Without this, a tree refresh
// with N expanded folders — or a single depth>1 prefetch walk —
// serialized past the server's 5 s timeout and surfaced as
// "agent did not respond" in the dashboard.
func (d *Daemon) handleFSList(ctx context.Context, req protocol.FSListRequestCommand) {
	d.mu.Lock()
	s, ok := d.supervisors[req.AgentID]
	d.mu.Unlock()
	if !ok {
		// Synthetic-error path is fast and Bus.Publish is thread-safe,
		// but we still publish inline here — there's no work to gate.
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.FSListResponseEvent{
			Kind:      "fs-list-response",
			MachineID: d.cache.MachineID,
			AgentID:   req.AgentID,
			RequestID: req.RequestID,
			Path:      req.Path,
			Error:     "agent not running on this machine",
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	go func() {
		d.fsSlots <- struct{}{}
		defer func() { <-d.fsSlots }()
		s.HandleFSList(ctx, req)
	}()
}

// handleFSRead routes an fs-read request to the target agent's
// supervisor. Same race window as handleFSList — publish a synthetic
// error response if the agent is gone, so the server-side pending
// request resolves instead of timing out. Async dispatch + shared
// fsSlots gate, same rationale as handleFSList.
func (d *Daemon) handleFSRead(ctx context.Context, req protocol.FSReadRequestCommand) {
	d.mu.Lock()
	s, ok := d.supervisors[req.AgentID]
	d.mu.Unlock()
	if !ok {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.FSReadResponseEvent{
			Kind:      "fs-read-response",
			MachineID: d.cache.MachineID,
			AgentID:   req.AgentID,
			RequestID: req.RequestID,
			Path:      req.Path,
			Result:    "error",
			Error:     "agent not running on this machine",
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	go func() {
		d.fsSlots <- struct{}{}
		defer func() { <-d.fsSlots }()
		s.HandleFSRead(ctx, req)
	}()
}

// handleGitLog mirrors handleFSList: routes to the target supervisor,
// publishes a synthetic error response if the agent is gone so the
// server-side pending request resolves instead of timing out, and
// dispatches the actual `git log` shell-out under the shared fsSlots
// gate (a depth-N tree refresh shouldn't queue behind a git log; same
// gate keeps total concurrent disk-touching ops bounded).
func (d *Daemon) handleGitLog(ctx context.Context, req protocol.GitLogRequestCommand) {
	d.mu.Lock()
	s, ok := d.supervisors[req.AgentID]
	d.mu.Unlock()
	if !ok {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.GitLogResponseEvent{
			Kind:      "git-log-response",
			MachineID: d.cache.MachineID,
			AgentID:   req.AgentID,
			RequestID: req.RequestID,
			Error:     "agent not running on this machine",
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	go func() {
		d.fsSlots <- struct{}{}
		defer func() { <-d.fsSlots }()
		s.HandleGitLog(ctx, req)
	}()
}

func (d *Daemon) handleCreateAgent(ctx context.Context, spec protocol.AgentSpec) {
	rec := agentSpecToRecord(spec)
	d.mu.Lock()
	if _, exists := d.supervisors[rec.AgentID]; exists {
		d.mu.Unlock()
		d.log.Printf("create-agent: %s already running (ignoring)", rec.AgentID)
		return
	}
	d.mu.Unlock()
	d.spawnSupervisor(ctx, rec, true)
}

func (d *Daemon) handleDestroyAgent(ctx context.Context, agentID string) {
	d.mu.Lock()
	s, ok := d.supervisors[agentID]
	if !ok {
		d.mu.Unlock()
		d.log.Printf("destroy-agent: %s not found", agentID)
		return
	}
	delete(d.supervisors, agentID)
	d.mu.Unlock()

	s.stop()
	d.removeFromCache(agentID)
	d.publishAgentDestroyed(ctx, agentID)
	d.log.Printf("destroyed agent %s", agentID)
	d.maybeStartTerminalLink(ctx)
}

// handleSyncAgents reconciles the supervisor set against the
// authoritative server-side list. We compute the intersection ourselves
// rather than tearing everything down and rebuilding so live
// supervisors keep their existing CLI subprocesses (and any in-flight
// commands) across reconciles.
func (d *Daemon) handleSyncAgents(ctx context.Context, specs []protocol.AgentSpec) {
	want := make(map[string]AgentRecord, len(specs))
	for _, sp := range specs {
		want[sp.AgentID] = agentSpecToRecord(sp)
	}

	d.mu.Lock()
	have := make(map[string]struct{}, len(d.supervisors))
	for id := range d.supervisors {
		have[id] = struct{}{}
	}
	d.mu.Unlock()

	for id := range have {
		if _, keep := want[id]; !keep {
			d.handleDestroyAgent(ctx, id)
		}
	}
	for id, rec := range want {
		if _, already := have[id]; already {
			// TODO(machine-driven): support in-place updates
			// (workingDir change, supportsTerminal toggle) by
			// detecting drift and bouncing the supervisor.
			continue
		}
		d.spawnSupervisor(ctx, rec, true)
	}
	d.log.Printf("sync-agents: reconciled to %d agent(s)", len(want))
	d.maybeStartTerminalLink(ctx)
}

// spawnSupervisor builds and starts a supervisor for one agent. If
// publishAck is true (i.e. this came from a control command, not a
// boot-time cache replay) we publish an agent-spawned / -spawn-failed
// event back to the server so the dashboard can flip status promptly.
//
// Persists the agent into the cache on success so a subsequent reboot
// can respawn it without waiting for the server to push a sync.
func (d *Daemon) spawnSupervisor(ctx context.Context, rec AgentRecord, publishAck bool) {
	s, err := newSupervisor(ctx, d.cache.MachineID, d.bus, rec, d.log)
	if err != nil {
		d.log.Printf("agent %s: spawn failed: %v", rec.AgentID, err)
		if publishAck {
			d.publishSpawnFailed(ctx, rec.AgentID, err.Error())
		}
		return
	}
	d.mu.Lock()
	d.supervisors[rec.AgentID] = s
	d.mu.Unlock()
	s.Start(ctx)

	d.upsertCache(rec)
	if publishAck {
		d.publishSpawned(ctx, rec.AgentID)
	}
	// Newly-spawned agents may have opted into terminal access; bring
	// the sidecar↔server link up if this is the first such agent on
	// the machine. Idempotent — safe to call from every spawn path
	// (boot replay, single create-agent, and bulk sync-agents).
	if rec.SupportsTerminal {
		d.maybeStartTerminalLink(ctx)
	}
}

func (d *Daemon) shutdownAllSupervisors() {
	d.mu.Lock()
	all := make([]*supervisor, 0, len(d.supervisors))
	for _, s := range d.supervisors {
		all = append(all, s)
	}
	d.mu.Unlock()
	var wg sync.WaitGroup
	wg.Add(len(all))
	for _, s := range all {
		go func(s *supervisor) {
			defer wg.Done()
			s.stop()
		}(s)
	}
	wg.Wait()
}

func (d *Daemon) publishSpawned(ctx context.Context, agentID string) {
	_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.AgentSpawnedEvent{
		Kind:      "agent-spawned",
		MachineID: d.cache.MachineID,
		AgentID:   agentID,
		TS:        time.Now().UnixMilli(),
	})
}

func (d *Daemon) publishSpawnFailed(ctx context.Context, agentID, reason string) {
	_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.AgentSpawnFailedEvent{
		Kind:      "agent-spawn-failed",
		MachineID: d.cache.MachineID,
		AgentID:   agentID,
		Reason:    reason,
		TS:        time.Now().UnixMilli(),
	})
}

func (d *Daemon) publishAgentDestroyed(ctx context.Context, agentID string) {
	_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.AgentDestroyedEvent{
		Kind:      "agent-destroyed",
		MachineID: d.cache.MachineID,
		AgentID:   agentID,
		TS:        time.Now().UnixMilli(),
	})
}

// maybeStartTerminalLink lazily brings up the sidecar↔server WebSocket
// the moment the first terminal-enabled agent is created, and tears it
// back down when the last one goes away. Avoids paying the link's
// keepalive cost on machines whose agents are all headless.
//
// Idempotent — safe to call after every reconcile / create / destroy.
func (d *Daemon) maybeStartTerminalLink(ctx context.Context) {
	d.mu.Lock()
	wantLink := false
	for _, s := range d.supervisors {
		if s.spec.SupportsTerminal {
			wantLink = true
			break
		}
	}
	hasLink := d.link != nil
	d.mu.Unlock()

	switch {
	case wantLink && !hasLink:
		if d.cache.Server.URL == "" {
			d.log.Printf("terminal: an agent opted into terminal access but server.url is unset in the cache; run `argus-sidecar init --force` to set it")
			return
		}
		d.startTerminalLink(ctx)
	case !wantLink && hasLink:
		// We deliberately do NOT tear the link down. Once started,
		// the link stays up for the daemon's lifetime — restarting
		// it on every churn would amplify reconnect storms after a
		// transient server hiccup. The link is cheap when idle.
	}
}

func (d *Daemon) startTerminalLink(ctx context.Context) {
	d.mu.Lock()
	if d.link != nil {
		d.mu.Unlock()
		return
	}
	link := sidecarlink.New(d.cache.Server.URL, d.cache.Server.Token, d.cache.MachineID, d.log)
	d.link = link
	settings := terminal.DefaultSettings()
	d.terminals = terminal.New(settings, d, link, d.log)
	d.mu.Unlock()

	go link.Run(ctx)
	go func() {
		if err := d.terminals.Run(ctx); err != nil {
			d.log.Printf("terminal runner error: %v", err)
		}
	}()
	d.log.Printf("terminal link started (server=%s)", d.cache.Server.URL)
}

// upsertCache replaces an existing agent record (matched by AgentID) or
// appends a new one, then persists. We rewrite the whole file each time;
// the agent set is bounded (low double digits in practice) and
// strict-consistency is more valuable than rewrite cost.
func (d *Daemon) upsertCache(rec AgentRecord) {
	d.mu.Lock()
	updated := false
	for i, existing := range d.cache.Agents {
		if existing.AgentID == rec.AgentID {
			d.cache.Agents[i] = rec
			updated = true
			break
		}
	}
	if !updated {
		d.cache.Agents = append(d.cache.Agents, rec)
	}
	snapshot := *d.cache
	snapshot.Agents = append([]AgentRecord(nil), d.cache.Agents...)
	d.mu.Unlock()

	if err := Save(d.cachePath, &snapshot); err != nil {
		d.log.Printf("cache save failed: %v", err)
	}
}

func (d *Daemon) removeFromCache(agentID string) {
	d.mu.Lock()
	out := d.cache.Agents[:0]
	for _, a := range d.cache.Agents {
		if a.AgentID != agentID {
			out = append(out, a)
		}
	}
	d.cache.Agents = out
	snapshot := *d.cache
	snapshot.Agents = append([]AgentRecord(nil), d.cache.Agents...)
	d.mu.Unlock()

	if err := Save(d.cachePath, &snapshot); err != nil {
		d.log.Printf("cache save failed: %v", err)
	}
}

// agentSpecToRecord converts the wire shape into the on-disk shape.
// Field-by-field rather than a type alias because the two evolve
// independently (cache may grow local-only fields like spawn-attempts).
func agentSpecToRecord(sp protocol.AgentSpec) AgentRecord {
	return AgentRecord{
		AgentID:          sp.AgentID,
		Name:             sp.Name,
		Type:             sp.Type,
		WorkingDir:       sp.WorkingDir,
		SupportsTerminal: sp.SupportsTerminal,
		Adapter:          sp.Adapter,
	}
}

// remarshal is a tiny helper: take a generic JSON-decoded map and
// re-decode it into a strongly-typed struct. Saves writing per-field
// type assertions for every control kind.
func remarshal(in any, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}
