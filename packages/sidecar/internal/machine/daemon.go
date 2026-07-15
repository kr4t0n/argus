package machine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/kr4t0n/argus/sidecar/internal/bus"
	"github.com/kr4t0n/argus/sidecar/internal/protocol"
	"github.com/kr4t0n/argus/sidecar/internal/quota"
	"github.com/kr4t0n/argus/sidecar/internal/sidecarlink"
	"github.com/kr4t0n/argus/sidecar/internal/terminal"
)

const (
	machineHeartbeatInterval = 5 * time.Second
	controlReadBlock         = 2 * time.Second
	// cmdReadBlock bounds the machine-wide command reader's XREADGROUP
	// so ctx cancellation is observed promptly. The stream set itself is
	// static per boot (one stream per installed CLI) — no re-snapshot on
	// expiry.
	cmdReadBlock = 2 * time.Second
	// cmdReadCount caps entries pulled per runner stream per read. Small
	// on purpose: commands are human-paced, and a tight cap bounds how
	// many sit buffered (and would be lost) if the daemon shuts down
	// mid-drain.
	cmdReadCount = 10
	// fsConcurrencyLimit caps how many fs-list / fs-read handlers run
	// in parallel across all workdirs. Picked empirically: high enough
	// that a tree refresh of ~20 expanded folders drains in parallel
	// instead of serializing through the control loop, low enough
	// that a malicious or buggy client can't fork-bomb the disk.
	// Goroutines that don't get a slot just queue at the channel
	// send — no requests are dropped.
	fsConcurrencyLimit = 16
	// cliConcurrencyLimit caps concurrent wrapped-CLI subprocess
	// spawns (model-catalog probes). Deliberately separate from
	// fsSlots: that gate is sized for millisecond disk walks, this
	// one for second-scale subprocesses that may hit vendor APIs
	// (cursor-agent models). Keeping them apart means a tree refresh
	// can't delay a catalog probe and vice versa. 4 covers the
	// realistic worst case — a boot-time push for every runner on the
	// machine plus a manual refresh — without herding processes.
	cliConcurrencyLimit = 4
)

// Daemon is the long-lived per-machine process. It owns a single bus
// connection, a single sidecar↔server link (for terminals), one runner
// per installed CLI type, and the per-workdir watcher registry driven
// by the server's sync-projects allowlist.
//
// The cache is the source of truth across daemon restarts: on boot we
// bring watchers + the fs jail up from the cached workdir allowlist
// immediately (so dashboard users don't see a blank machine while the
// server reconciles), then a SyncProjectsCommand from the server
// reconciles any drift that happened while we were offline.
type Daemon struct {
	cachePath      string
	cache          *Cache
	sidecarVersion string
	bus            *bus.Bus
	link           *sidecarlink.Client // nil unless server.url is configured
	terminals      *terminal.Runner    // nil unless link is up
	log            *log.Logger

	mu       sync.Mutex
	runners  map[string]*runner // cliType → runner
	workdirs []string           // sync-projects allowlist (sorted)
	watchers *watchRegistry

	// availableAdapters captured once at boot; the dashboard reads this
	// to decide which CLI types this machine can run.
	availableAdapters []protocol.AvailableAdapter
	hostname          string

	// quota is the per-CLI plan-quota prober. Lazy: built in Run() and
	// shut down with the daemon. Heartbeats read its cached snapshot.
	quota *quota.Prober

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

	// Bounded-concurrency gate for wrapped-CLI subprocess spawns
	// (model-catalog probes). See cliConcurrencyLimit for why this is
	// not fsSlots.
	cliSlots chan struct{}
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
		runners:        make(map[string]*runner),
		hostname:       hn,
		update:         &UpdateState{},
		fsSlots:        make(chan struct{}, fsConcurrencyLimit),
		cliSlots:       make(chan struct{}, cliConcurrencyLimit),
	}
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

	// One runner per installed CLI — the set is static for this boot;
	// a newly installed CLI is picked up on the next daemon restart.
	for _, a := range d.availableAdapters {
		d.spawnRunner(ctx, a.Type)
	}

	// Seed the workdir allowlist from the persisted sync-projects
	// snapshot. The server re-sends sync-projects on every
	// machine-register, so any drift reconciles within one round trip.
	d.watchers = newWatchRegistry(d.cache.MachineID, d.bus, d.log)
	boot := append([]string(nil), d.cache.Workdirs...)
	d.setWorkdirs(ctx, boot)

	d.startTerminalLink(ctx)

	d.quota = quota.New(d.log)

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		d.machineHeartbeatLoop(ctx)
	}()
	go func() {
		defer wg.Done()
		d.quota.Run(ctx)
	}()
	// Single machine-wide command reader: fans in every runner's command
	// stream on one connection.
	go func() {
		defer wg.Done()
		d.commandReaderLoop(ctx)
	}()

	consumer := "c-" + uuid.NewString()[:8]
	d.mu.Lock()
	nRunners, nWorkdirs := len(d.runners), len(d.workdirs)
	d.mu.Unlock()
	d.log.Printf("machine ready id=%s name=%s runners=%d projects=%d",
		d.cache.MachineID, d.cache.Name, nRunners, nWorkdirs)

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

	d.shutdownAllRunners()
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
			var quotas []protocol.AgentQuota
			if d.quota != nil {
				quotas = d.quota.Latest()
			}
			err := d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.MachineHeartbeatEvent{
				Kind:      "machine-heartbeat",
				MachineID: d.cache.MachineID,
				Quotas:    quotas,
				TS:        time.Now().UnixMilli(),
			})
			if err != nil {
				d.log.Printf("machine-heartbeat publish failed: %v", err)
			}
		}
	}
}

// commandReaderLoop is the single, machine-wide consumer of every
// runner's command stream. One blocking XREADGROUP fans in over all
// machine:{id}:cli:{type}:cmd streams under one consumer group, then
// routes each entry to the owning runner over its in-process channel —
// the machine reads commands on a single connection regardless of how
// many CLIs it runs.
//
// The stream set is snapshotted ONCE: runners are spawned per installed
// CLI at boot and never churn, so the old per-iteration re-snapshot of
// the agent stream set (and its 2 s pickup window) is gone.
func (d *Daemon) commandReaderLoop(ctx context.Context) {
	group := protocol.SidecarCommandGroup(d.cache.MachineID)
	consumer := "cmd-" + uuid.NewString()[:8]

	// Groups are ensured at spawn time, so every stream here already has
	// its group (except after a Redis flush — handled via the NOGROUP
	// branch below).
	d.mu.Lock()
	streams := make([]string, 0, len(d.runners))
	routes := make(map[string]*runner, len(d.runners))
	for cliType, r := range d.runners {
		st := protocol.RunnerCommandStream(d.cache.MachineID, cliType)
		streams = append(streams, st)
		routes[st] = r
	}
	d.mu.Unlock()

	if len(streams) == 0 {
		// No CLIs installed — nothing to read, ever (the set is static
		// per boot). The machine still serves control-plane RPCs.
		d.log.Printf("command reader: no runners; reader idle until restart")
		return
	}

	for {
		if ctx.Err() != nil {
			return
		}

		msgs, err := d.bus.ReadGroupMulti(ctx, streams, group, consumer, cmdReadCount, cmdReadBlock)
		if errors.Is(err, context.Canceled) {
			return
		}
		if err != nil {
			// After a Redis flush (the bus holds no durable data) the
			// groups vanish and XREADGROUP fails NOGROUP for the whole
			// batch. Recreate the groups on the current streams and retry
			// — without this the reader would log-and-sleep forever and
			// never deliver another command until the daemon was bounced.
			if isNoGroup(err) {
				d.ensureCommandGroups(ctx, streams, group)
				continue
			}
			d.log.Printf("command read error: %v", err)
			time.Sleep(time.Second)
			continue
		}

		for _, m := range msgs {
			r := routes[m.Stream]
			if r == nil || !r.enqueue(inboundCmd{msgID: m.ID, payload: m.Payload}) {
				// Runner is shutting down. Ack-drop so the entry doesn't
				// dangle in the PEL.
				_ = d.bus.Ack(ctx, m.Stream, group, m.ID)
			}
		}
	}
}

// ensureCommandGroups (re)creates the shared command consumer group on
// each stream. The reader uses it to self-heal after a Redis flush.
func (d *Daemon) ensureCommandGroups(ctx context.Context, streams []string, group string) {
	for _, st := range streams {
		if err := d.bus.EnsureGroup(ctx, st, group); err != nil {
			d.log.Printf("command reader: ensure group on %s: %v", st, err)
		}
	}
}

// isNoGroup reports whether err is Redis's NOGROUP (missing stream or
// consumer group), which the reader treats as "recreate the group(s) and
// retry" rather than a transient error to back off on.
func isNoGroup(err error) bool {
	return err != nil && strings.Contains(err.Error(), "NOGROUP")
}

// dispatchControl decodes a single control message and routes it to the
// matching handler. We discriminate by `kind` so adding new commands is
// just a new case.
func (d *Daemon) dispatchControl(ctx context.Context, payload map[string]any) {
	kindStr, _ := payload["kind"].(string)
	switch kindStr {
	case "sync-projects":
		var ev protocol.SyncProjectsCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad sync-projects: %v", err)
			return
		}
		d.handleSyncProjects(ctx, ev)
	case "create-agent", "destroy-agent", "sync-agents":
		// Pre-runner control plane. This sidecar (≥0.3.x) has no
		// per-agent supervisors to create or destroy; a Phase-3 server
		// sends sync-projects instead. Old-server + new-sidecar is an
		// unsupported pairing (see docs/plan-agent-to-runners.md §Phase 3).
		d.log.Printf("control: ignoring %q — agent-addressed control from a pre-runner server; upgrade the server", kindStr)
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
	case "list-models":
		var ev protocol.ListModelsRequestCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad list-models: %v", err)
			return
		}
		d.handleListModels(ctx, ev)
	case "update-sidecar":
		var ev protocol.UpdateSidecarCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad update-sidecar: %v", err)
			return
		}
		d.handleUpdateSidecar(ctx, ev)
	case "sync-user-rules":
		var ev protocol.SyncUserRulesCommand
		if err := remarshal(payload, &ev); err != nil {
			d.log.Printf("control: bad sync-user-rules: %v", err)
			return
		}
		d.handleSyncUserRules(ev)
	default:
		d.log.Printf("control: unknown kind=%q", kindStr)
	}
}

// handleSyncProjects reconciles the workdir allowlist (and with it the
// watcher registry and fs/git jail) against the server's authoritative
// snapshot. Idempotent by design — the server re-sends the full list on
// every machine-register and on any project change.
func (d *Daemon) handleSyncProjects(ctx context.Context, ev protocol.SyncProjectsCommand) {
	d.setWorkdirs(ctx, ev.Workdirs)
	d.mu.Lock()
	n := len(d.workdirs)
	d.mu.Unlock()
	d.log.Printf("sync-projects: reconciled to %d workdir(s)", n)
}

// setWorkdirs installs a normalized allowlist, reconciles the watcher
// registry against it, and persists it to the cache. Shared by boot
// (cache seed + Agents migration) and handleSyncProjects.
func (d *Daemon) setWorkdirs(ctx context.Context, workdirs []string) {
	normalized := normalizeWorkdirs(workdirs)

	d.mu.Lock()
	d.workdirs = normalized
	snapshot := *d.cache
	snapshot.Workdirs = append([]string(nil), normalized...)
	d.cache.Workdirs = snapshot.Workdirs
	d.mu.Unlock()

	d.watchers.Reconcile(ctx, normalized)

	if err := Save(d.cachePath, &snapshot); err != nil {
		d.log.Printf("cache save failed: %v", err)
	}
}

// normalizeWorkdirs dedupes, drops empties, and sorts so the persisted
// allowlist (and reconcile behavior) is deterministic regardless of the
// order the server enumerated projects in.
func normalizeWorkdirs(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, wd := range in {
		if wd == "" {
			continue
		}
		if _, dup := seen[wd]; dup {
			continue
		}
		seen[wd] = struct{}{}
		out = append(out, wd)
	}
	sort.Strings(out)
	return out
}

// workdirAllowed reports whether wd is on the sync-projects allowlist.
// The allowlist is the security boundary for workdir-addressed fs/git
// RPCs (plan §4.3): the daemon must never serve a path the server
// invents, only project dirs the server registered through an explicit
// sync-projects control command (or the cache carried over).
func (d *Daemon) workdirAllowed(wd string) bool {
	if wd == "" {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, known := range d.workdirs {
		if known == wd {
			return true
		}
	}
	return false
}

// legacyAgentAddressingError is the synthetic error published when a
// request arrives with only agentId addressing. A Phase-3 server always
// sends workingDir; hitting this path means an old server is talking to
// a runner-mode sidecar.
const legacyAgentAddressingError = "agent addressing is not supported by this sidecar — upgrade the server"

// handleFSList serves an fs-list request. Workdir-addressed requests
// (`workingDir` set) are validated against the allowlist and served
// directly; legacy agent-addressed requests get a synthetic error — the
// Phase-3 server always sends workingDir, so that path only fires
// against pre-runner servers. Publishing the synthetic response (rather
// than dropping) lets the server-side pending request resolve instead
// of timing out.
//
// The actual listing runs in a goroutine bounded by fsSlots so the
// control loop returns immediately. Without this, a tree refresh
// with N expanded folders — or a single depth>1 prefetch walk —
// serialized past the server's 5 s timeout and surfaced as
// "agent did not respond" in the dashboard.
func (d *Daemon) handleFSList(ctx context.Context, req protocol.FSListRequestCommand) {
	if req.WorkingDir == "" {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.FSListResponseEvent{
			Kind:      "fs-list-response",
			MachineID: d.cache.MachineID,
			RequestID: req.RequestID,
			Path:      req.Path,
			Error:     legacyAgentAddressingError,
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	if !d.workdirAllowed(req.WorkingDir) {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.FSListResponseEvent{
			Kind:      "fs-list-response",
			MachineID: d.cache.MachineID,
			RequestID: req.RequestID,
			Path:      req.Path,
			Error:     "workingDir is not a known project on this machine",
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	go func() {
		d.fsSlots <- struct{}{}
		defer func() { <-d.fsSlots }()
		serveFSList(ctx, d.bus, d.log, d.cache.MachineID, req.WorkingDir, req)
	}()
}

// handleFSRead mirrors handleFSList: allowlist-validated workdir
// addressing, synthetic error for legacy agent addressing, async
// dispatch under the shared fsSlots gate.
func (d *Daemon) handleFSRead(ctx context.Context, req protocol.FSReadRequestCommand) {
	if req.WorkingDir == "" {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.FSReadResponseEvent{
			Kind:      "fs-read-response",
			MachineID: d.cache.MachineID,
			RequestID: req.RequestID,
			Path:      req.Path,
			Result:    "error",
			Error:     legacyAgentAddressingError,
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	if !d.workdirAllowed(req.WorkingDir) {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.FSReadResponseEvent{
			Kind:      "fs-read-response",
			MachineID: d.cache.MachineID,
			RequestID: req.RequestID,
			Path:      req.Path,
			Result:    "error",
			Error:     "workingDir is not a known project on this machine",
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	go func() {
		d.fsSlots <- struct{}{}
		defer func() { <-d.fsSlots }()
		serveFSRead(ctx, d.bus, d.log, d.cache.MachineID, req.WorkingDir, req)
	}()
}

// handleGitLog mirrors handleFSList: allowlist-validated workdir
// addressing, synthetic error for legacy agent addressing, and the
// actual `git log` shell-out dispatched under the shared fsSlots gate
// (a depth-N tree refresh shouldn't queue behind a git log; same gate
// keeps total concurrent disk-touching ops bounded).
func (d *Daemon) handleGitLog(ctx context.Context, req protocol.GitLogRequestCommand) {
	if req.WorkingDir == "" {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.GitLogResponseEvent{
			Kind:      "git-log-response",
			MachineID: d.cache.MachineID,
			RequestID: req.RequestID,
			Error:     legacyAgentAddressingError,
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	if !d.workdirAllowed(req.WorkingDir) {
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.GitLogResponseEvent{
			Kind:      "git-log-response",
			MachineID: d.cache.MachineID,
			RequestID: req.RequestID,
			Error:     "workingDir is not a known project on this machine",
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	go func() {
		d.fsSlots <- struct{}{}
		defer func() { <-d.fsSlots }()
		serveGitLog(ctx, d.bus, d.log, d.cache.MachineID, req.WorkingDir, req)
	}()
}

// handleListModels routes a list-models request to the runner for the
// requested CLI type — the catalog is a property of the installed
// binary. Unknown or missing cliType gets a synthetic error response
// (echoing RequestID) so the server-side pending request
// resolves instead of timing out. Gated by cliSlots (not fsSlots) so
// catalog probes and tree walks can't queue behind each other.
func (d *Daemon) handleListModels(ctx context.Context, req protocol.ListModelsRequestCommand) {
	d.mu.Lock()
	r, ok := d.runners[req.CliType]
	d.mu.Unlock()
	if !ok {
		reason := fmt.Sprintf("cli type %q is not installed on this machine", req.CliType)
		if req.CliType == "" {
			reason = legacyAgentAddressingError
		}
		_ = d.bus.Publish(ctx, protocol.LifecycleStream(), protocol.ModelCatalogResponseEvent{
			Kind:      "model-catalog-response",
			MachineID: d.cache.MachineID,
			CliType:   req.CliType,
			RequestID: req.RequestID,
			Error:     reason,
			TS:        time.Now().UnixMilli(),
		})
		return
	}
	go func() {
		d.cliSlots <- struct{}{}
		defer func() { <-d.cliSlots }()
		r.HandleListModels(ctx, req)
	}()
}

// spawnRunner builds and starts the runner for one installed CLI type.
// Failures are logged and skipped — the type just won't be dispatchable
// this boot (Discover already LookPath'd the binary, so this is rare).
func (d *Daemon) spawnRunner(ctx context.Context, cliType string) {
	r, err := newRunner(ctx, d.cache.MachineID, d.cache.Server.URL, d.bus, cliType, d.log)
	if err != nil {
		d.log.Printf("runner %s: spawn failed: %v", cliType, err)
		return
	}
	// Ensure the shared command group on this runner's stream BEFORE the
	// runner becomes visible to the machine-wide reader (added to the
	// map) — so the reader never hits NOGROUP on it, and no command
	// published right after machine-register lands ahead of the group's
	// start position. Non-fatal: the reader re-ensures groups if it ever
	// does hit NOGROUP (e.g. after a Redis flush).
	cmdStream := protocol.RunnerCommandStream(d.cache.MachineID, cliType)
	group := protocol.SidecarCommandGroup(d.cache.MachineID)
	if err := d.bus.EnsureGroup(ctx, cmdStream, group); err != nil {
		d.log.Printf("runner %s: ensure command group: %v", cliType, err)
	}
	// Start the runner (which sets r.runCtx) BEFORE publishing it to
	// the map. The machine-wide reader routes commands by reading the map
	// under d.mu, then calls r.enqueue — which selects on r.runCtx. If we
	// inserted first, the reader could see a runner whose runCtx isn't
	// set yet. Inserting after Start (with the lock as the barrier) means
	// any reader that can see the runner also sees a live runCtx.
	r.Start(ctx)
	d.mu.Lock()
	d.runners[cliType] = r
	d.mu.Unlock()

	// Warm the server's stored model catalog so a picker opening later
	// never waits on a live CLI exec. Best-effort and fully off the
	// spawn path; cliSlots keeps a multi-CLI boot from herding
	// subprocesses.
	go func() {
		d.cliSlots <- struct{}{}
		defer func() { <-d.cliSlots }()
		r.PushModelCatalog(ctx)
	}()
}

func (d *Daemon) shutdownAllRunners() {
	d.mu.Lock()
	all := make([]*runner, 0, len(d.runners))
	for _, r := range d.runners {
		all = append(all, r)
	}
	d.mu.Unlock()
	var wg sync.WaitGroup
	wg.Add(len(all))
	for _, r := range all {
		go func(r *runner) {
			defer wg.Done()
			r.stop()
		}(r)
	}
	wg.Wait()
}

// startTerminalLink brings up the sidecar↔server WebSocket at boot when
// a server URL is configured. Terminal capability gating moved
// server-side with the runner refactor (there is no per-agent opt-in on
// the sidecar anymore), so the link is unconditional: it's cheap when
// idle, and once started it stays up for the daemon's lifetime —
// restarting it on churn would amplify reconnect storms after a
// transient server hiccup.
func (d *Daemon) startTerminalLink(ctx context.Context) {
	if d.cache.Server.URL == "" {
		d.log.Printf("terminal: server.url is unset in the cache; terminals disabled (run `argus-sidecar init --force` to set it)")
		return
	}
	d.mu.Lock()
	if d.link != nil {
		d.mu.Unlock()
		return
	}
	link := sidecarlink.New(d.cache.Server.URL, d.cache.Server.Token, d.cache.MachineID, d.log)
	d.link = link
	settings := terminal.DefaultSettings()
	d.terminals = terminal.New(settings, link, d.log)
	d.mu.Unlock()

	go link.Run(ctx)
	go func() {
		if err := d.terminals.Run(ctx); err != nil {
			d.log.Printf("terminal runner error: %v", err)
		}
	}()
	d.log.Printf("terminal link started (server=%s)", d.cache.Server.URL)
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
