package machine

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/kr4t0n/argus/sidecar/internal/adapter"
	"github.com/kr4t0n/argus/sidecar/internal/bus"
	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// runner owns one installed CLI on this machine: an adapter instance and
// the loop consuming commands the daemon fanned in from the runner's
// machine×CLI command stream (Phase 3 of docs/plan-agent-to-runners.md).
// One runner per CLI type replaces the old one-supervisor-per-agent
// model; the per-command workingDir (Command.WorkingDir, pinned on the
// Session server-side) is what used to be the agent's identity.
//
// Runners never register, heartbeat, or watch the filesystem — machine
// liveness is the only presence signal (the machine heartbeat loop), and
// workdir watchers live in the daemon's watchRegistry, driven by the
// sync-projects allowlist.
//
// runner is intentionally NOT exported — the daemon spawns one per
// discovered adapter type at boot; the set is static for the daemon's
// lifetime.
type runner struct {
	cliType string
	machine string // machine *id*, the parent's MachineID
	bus     *bus.Bus
	adapter adapter.Adapter
	version string // detected CLI version, "" if detection failed
	log     *log.Logger

	// serverURL + httpClient let the runner pull a turn's attachments
	// over HTTP from the server (the S3 gateway) before invoking the CLI.
	// serverURL is the same base the sidecar link / quota use; empty means
	// attachments are skipped (logged) rather than failing the turn.
	serverURL  string
	httpClient *http.Client

	cmdCancel context.CancelFunc
	doneCh    chan struct{}

	// cmdCh receives commands the daemon's single machine-wide reader
	// fanned in from this runner's command stream. Replaces the old
	// per-agent blocking XREADGROUP loop (which parked one Redis
	// connection per agent) with an in-process hand-off, so the whole
	// machine reads commands on one connection regardless of CLI count.
	cmdCh chan inboundCmd

	// runCtx is the runner's run-scoped context, cancelled by stop()
	// (or parent shutdown). enqueue selects on it so the reader never
	// blocks handing a command to a runner that's already draining.
	runCtx context.Context

	cancels sync.Map // commandID → context.CancelFunc
}

// cmdQueueDepth buffers commands the daemon's machine-wide reader
// hands to a runner. Generous because the run loop drains it fast
// (execution is offloaded to goroutines); the buffer just absorbs a
// burst so the shared reader isn't stalled by one CLI.
const cmdQueueDepth = 64

// inboundCmd is one command the machine-wide reader hands to a runner:
// the raw decoded stream payload plus the Redis stream message ID the
// runner must ack once the command is handled.
type inboundCmd struct {
	msgID   string
	payload map[string]any
}

// newRunner builds (and `Ping`s) the adapter for one installed CLI type.
// It does NOT start the consume loop — the daemon does that via Start,
// so it can register the runner in its own bookkeeping atomically.
//
// The adapter cfg deliberately carries NO workingDir: the per-run dir
// arrives on every command (Command.WorkingDir) and adapters resolve it
// per execution.
func newRunner(
	ctx context.Context,
	machineID string,
	serverURL string,
	b *bus.Bus,
	cliType string,
	logger *log.Logger,
) (*runner, error) {
	ad, err := adapter.New(cliType, map[string]any{})
	if err != nil {
		return nil, fmt.Errorf("build adapter: %w", err)
	}
	if err := ad.Ping(ctx); err != nil {
		// Non-fatal: keep going so the machine still exposes the CLI
		// instead of a silent failure. handleCommand will surface a
		// real error if the CLI never recovers.
		logger.Printf("runner %s: adapter ping failed: %v (will keep running)", cliType, err)
	}

	version := ""
	if v, ok := ad.(adapter.Versioned); ok {
		if detected, verr := v.Version(ctx); verr == nil && detected != "" {
			version = detected
		} else if verr != nil {
			logger.Printf("runner %s: version detection failed: %v", cliType, verr)
		}
	}

	return &runner{
		cliType:    cliType,
		machine:    machineID,
		bus:        b,
		adapter:    ad,
		version:    version,
		log:        logger,
		serverURL:  serverURL,
		httpClient: &http.Client{Timeout: 2 * time.Minute},
		doneCh:     make(chan struct{}),
		cmdCh:      make(chan inboundCmd, cmdQueueDepth),
	}, nil
}

// Start kicks off the command consume loop in a dedicated goroutine
// bound to ctx. Returns immediately. Callers stop the runner by either:
//   - cancelling parent ctx (graceful daemon shutdown)
//   - calling stop() (targeted teardown)
func (r *runner) Start(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	r.cmdCancel = cancel
	r.runCtx = ctx
	go func() {
		defer close(r.doneCh)
		r.run(ctx)
	}()
}

// stop cancels the runner's context and waits for it to drain. Safe to
// call multiple times.
func (r *runner) stop() {
	if r.cmdCancel != nil {
		r.cmdCancel()
	}
	<-r.doneCh
}

// enqueue hands one command to the runner's run loop. Returns false if
// the runner is shutting down (run-scoped ctx cancelled), so the
// machine-wide reader can ack-drop the entry instead of blocking on a
// runner that will never drain it.
func (r *runner) enqueue(m inboundCmd) bool {
	select {
	case r.cmdCh <- m:
		return true
	case <-r.runCtx.Done():
		return false
	}
}

func (r *runner) run(ctx context.Context) {
	// Commands arrive over r.cmdCh from the daemon's single machine-wide
	// reader (Daemon.commandReaderLoop), not from a per-runner XREADGROUP
	// — that's what keeps the machine on one Redis connection regardless
	// of CLI count. The consumer group is ensured by the daemon at spawn
	// time; this loop only needs the stream/group names to ack.
	cmdStream := protocol.RunnerCommandStream(r.machine, r.cliType)
	group := protocol.SidecarCommandGroup(r.machine)
	r.log.Printf("runner %s ready (version=%q)", r.cliType, r.version)

	var wg sync.WaitGroup
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case m := <-r.cmdCh:
			r.dispatchCommand(ctx, &wg, cmdStream, group, m)
		}
	}

	// Drain in-flight execute/clone goroutines before reporting done.
	wg.Wait()
}

// dispatchCommand handles one command handed in by the machine-wide
// reader: a malformed entry is acked and dropped; cancels are handled
// inline and acked immediately; clone-session and execute run on their
// own goroutines (tracked by wg so shutdown drains them) and ack on
// completion.
func (r *runner) dispatchCommand(ctx context.Context, wg *sync.WaitGroup, cmdStream, group string, m inboundCmd) {
	if m.payload == nil {
		r.log.Printf("runner %s: dropping malformed command entry %s", r.cliType, m.msgID)
		_ = r.bus.Ack(ctx, cmdStream, group, m.msgID)
		return
	}

	cmd, err := decodeCommand(m.payload)
	if err != nil {
		r.log.Printf("runner %s: decode command: %v", r.cliType, err)
		_ = r.bus.Ack(ctx, cmdStream, group, m.msgID)
		return
	}

	if cmd.Kind == "cancel" {
		if c, ok := r.cancels.Load(cmd.ID); ok {
			c.(context.CancelFunc)()
		}
		_ = r.adapter.Cancel(ctx, cmd.ID)
		_ = r.bus.Ack(ctx, cmdStream, group, m.msgID)
		return
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
			r.handleCloneSession(ctx, c)
			_ = r.bus.Ack(ctx, cmdStream, group, id)
		}(cmd, m.msgID)
		return
	}

	wg.Add(1)
	go func(c protocol.Command, id string) {
		defer wg.Done()
		r.handleCommand(ctx, c)
		_ = r.bus.Ack(ctx, cmdStream, group, id)
	}(cmd, m.msgID)
}

// handleCloneSession runs a fork of the CLI's on-disk session state in
// the command's workingDir. Adapters opt in by implementing
// adapter.Cloner; if this runner's adapter doesn't (or the clone
// otherwise fails), we publish a SessionCloneFailedEvent so the
// dashboard can toast. A ResultChunk would be wrong here — the
// clone-session command has no Command row in the server DB, and a
// chunk insert would FK-violate against Command.id and get silently
// dropped.
//
// Successful clones emit a SessionExternalIDEvent on the result stream,
// which the server's result-ingestor consumes to set the new session's
// externalId — making future commands resume the cloned conversation.
func (r *runner) handleCloneSession(parent context.Context, cmd protocol.Command) {
	resultStream := protocol.RunnerResultStream(r.machine, r.cliType)
	publishErr := func(reason string) {
		_ = r.bus.Publish(parent, resultStream, protocol.SessionCloneFailedEvent{
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
	cloner, ok := r.adapter.(adapter.Cloner)
	if !ok {
		publishErr(fmt.Sprintf("adapter %s does not support session cloning", r.cliType))
		return
	}
	newID, err := cloner.CloneSession(parent, cmd.WorkingDir, cmd.Clone.SrcExternalID, cmd.Clone.TurnIndex)
	if err != nil {
		r.log.Printf("runner %s: clone-session failed: %v", r.cliType, err)
		publishErr(err.Error())
		return
	}
	if err := r.bus.Publish(parent, resultStream, protocol.SessionExternalIDEvent{
		Kind:       "session-external-id",
		SessionID:  cmd.SessionID,
		CommandID:  cmd.ID,
		ExternalID: newID,
		TS:         time.Now().UnixMilli(),
	}); err != nil {
		r.log.Printf("runner %s: clone-session publish external id failed: %v", r.cliType, err)
	}
}

func (r *runner) handleCommand(parent context.Context, cmd protocol.Command) {
	cmdCtx, cancel := context.WithCancel(parent)
	defer cancel()
	r.cancels.Store(cmd.ID, cancel)
	defer r.cancels.Delete(cmd.ID)

	// Routing already happened via the machine×CLI stream, and chunks
	// carry commandId/sessionId for ingestion.
	resultStream := protocol.RunnerResultStream(r.machine, r.cliType)
	seq := 0
	publishExternalIDOnce := false

	// Pull + land any attached files BEFORE running the CLI. This sets
	// each ref's LocalPath and appends a path-listing preamble to the
	// prompt; adapters then reference the files (codex via --image, the
	// rest via the prompt path). Fail-soft: a bad pull is skipped, not
	// fatal to the turn.
	r.materializeAttachments(cmdCtx, &cmd)

	chunks, err := r.adapter.Execute(cmdCtx, cmd)
	if err != nil {
		seq++
		_ = r.bus.Publish(parent, resultStream, protocol.ResultChunk{
			ID:        uuid.NewString(),
			CommandID: cmd.ID,
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
			_ = r.bus.Publish(parent, resultStream, protocol.SessionExternalIDEvent{
				Kind:       "session-external-id",
				SessionID:  cmd.SessionID,
				CommandID:  cmd.ID,
				ExternalID: c.ExternalID,
				TS:         time.Now().UnixMilli(),
			})
		}
		seq++
		_ = r.bus.Publish(parent, resultStream, protocol.ResultChunk{
			ID:        uuid.NewString(),
			CommandID: cmd.ID,
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

// HandleListModels answers a `list-models` control request with this
// CLI's model catalog. Same fan-in pattern as the fs/git RPCs. The
// claude-code catalog is a compiled-in table (instant); codex / cursor
// shell out to their CLIs, and cursor's `models` hits the vendor API,
// so the exec gets its own deadline well under the server-side request
// timeout — a wedged CLI must surface as a catalog error, not a server
// timeout the dashboard can't tell apart from an offline machine.
// The server's pending map is keyed by RequestID.
func (r *runner) HandleListModels(ctx context.Context, req protocol.ListModelsRequestCommand) {
	resp := protocol.ModelCatalogResponseEvent{
		Kind:      "model-catalog-response",
		MachineID: r.machine,
		CliType:   r.cliType,
		RequestID: req.RequestID,
		TS:        time.Now().UnixMilli(),
	}
	if lister, ok := r.adapter.(adapter.ModelLister); ok {
		execCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		models, source, err := lister.ListModels(execCtx)
		cancel()
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Models = models
			resp.Source = source
		}
	} else {
		resp.Error = "adapter does not support model listing"
	}
	if err := r.bus.Publish(ctx, protocol.LifecycleStream(), resp); err != nil {
		r.log.Printf("runner %s: model-catalog-response publish failed: %v", r.cliType, err)
	}
}

// PushModelCatalog publishes an UNSOLICITED model-catalog event
// (RequestID == "") so the server's stored catalog is warm before any
// picker opens. Called by the daemon once per runner spawn — one probe
// per installed CLI instead of the old per-agent push — under the
// cliSlots gate. Best-effort: probe failures are logged, never
// published, so a boot-time CLI hiccup can't clobber a previously
// stored good catalog server-side.
//
// The exec deadline is more generous than HandleListModels' 12s: no
// user is waiting, and a slow vendor endpoint at boot is exactly the
// case where we'd rather wait than give up and leave the store cold.
func (r *runner) PushModelCatalog(ctx context.Context) {
	lister, ok := r.adapter.(adapter.ModelLister)
	if !ok {
		return
	}
	execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	models, source, err := lister.ListModels(execCtx)
	cancel()
	if err != nil {
		r.log.Printf("runner %s: model catalog probe failed: %v", r.cliType, err)
		return
	}
	ev := protocol.ModelCatalogResponseEvent{
		Kind:      "model-catalog-response",
		MachineID: r.machine,
		CliType:   r.cliType,
		RequestID: "", // unsolicited push
		Source:    source,
		Models:    models,
		TS:        time.Now().UnixMilli(),
	}
	if err := r.bus.Publish(ctx, protocol.LifecycleStream(), ev); err != nil {
		r.log.Printf("runner %s: model-catalog push publish failed: %v", r.cliType, err)
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
