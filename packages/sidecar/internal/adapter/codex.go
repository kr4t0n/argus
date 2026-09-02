package adapter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// CodexAdapter runs each active turn through `codex app-server`, exposing
// native thread, turn, fork, and interrupt operations over JSONL stdio. The
// connection closes before the terminal chunk is emitted so external Codex
// clients can immediately acquire the thread-store writer.
//
// By default, fullAuto disables approval prompts and selects
// danger-full-access sandboxing, matching the old non-interactive behavior.
//
// An explicit sandbox setting takes precedence over fullAuto.
type CodexAdapter struct {
	binary     string
	workingDir string
	fullAuto   bool
	sandbox    string // optional override; takes precedence over fullAuto
	extraArgs  []string

	modelMu  sync.Mutex
	models   map[string]string
	activeMu sync.Mutex
	active   map[string]*codexActiveTurn
}

type codexActiveTurn struct {
	client    *codexAppServer
	threadID  string
	turnID    string
	cancelled bool
	ready     chan struct{}
	readyOnce sync.Once
	// terminated closes when the turn's stream has gone terminal and its
	// connection has been released. Cancel waits on it to decide whether a
	// graceful interrupt worked or the connection has to be forced shut.
	terminated chan struct{}
}

// codexInterruptGrace bounds how long a cancelled turn may keep its
// connection open waiting for app-server to finalize the interrupted turn on
// disk. Matches the SIGTERM->SIGKILL window the exec-based adapter used.
const codexInterruptGrace = 3 * time.Second

const codexDefaultBinary = "codex"

func init() {
	Register("codex", Plugin{
		DefaultBinary: codexDefaultBinary,
		Factory: func(cfg map[string]any) (Adapter, error) {
			bin, _ := cfg["binary"].(string)
			if bin == "" {
				bin = codexDefaultBinary
			}
			if _, err := exec.LookPath(bin); err != nil {
				return nil, fmt.Errorf("codex CLI %q not found: %w", bin, err)
			}
			a := &CodexAdapter{
				binary:     bin,
				workingDir: WorkingDirFromCfg(cfg),
				fullAuto:   boolFromCfg(cfg, "fullAuto", true),
				active:     make(map[string]*codexActiveTurn),
				models:     make(map[string]string),
			}
			if s, ok := cfg["sandbox"].(string); ok {
				a.sandbox = s
			}
			if extra, ok := cfg["extraArgs"].([]any); ok {
				for _, v := range extra {
					if s, ok := v.(string); ok {
						a.extraArgs = append(a.extraArgs, s)
					}
				}
			}
			return a, nil
		},
	})
}

func boolFromCfg(cfg map[string]any, key string, def bool) bool {
	v, ok := cfg[key]
	if !ok {
		return def
	}
	if b, ok := v.(bool); ok {
		return b
	}
	return def
}

func (a *CodexAdapter) Ping(ctx context.Context) error {
	client, err := startCodexAppServer(ctx, a.binary, a.workingDir, a.extraArgs)
	if client != nil {
		_ = client.Close()
	}
	return err
}

func (a *CodexAdapter) Version(ctx context.Context) (string, error) {
	return readBinaryVersion(ctx, a.binary)
}

func (a *CodexAdapter) Execute(
	ctx context.Context, cmd protocol.Command,
) (<-chan Chunk, error) {
	active := &codexActiveTurn{ready: make(chan struct{}), terminated: make(chan struct{})}
	a.activeMu.Lock()
	a.active[cmd.ID] = active
	a.activeMu.Unlock()
	var client *codexAppServer
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			active.readyOnce.Do(func() { close(active.ready) })
			a.activeMu.Lock()
			delete(a.active, cmd.ID)
			a.activeMu.Unlock()
			if client != nil {
				_ = client.Close()
			}
			close(active.terminated)
		})
	}
	var err error
	client, err = startCodexAppServer(ctx, a.binary, a.workingDir, a.extraArgs)
	if err != nil {
		cleanup()
		return nil, err
	}
	a.activeMu.Lock()
	active.client = client
	a.activeMu.Unlock()

	threadID, resolvedModel, err := a.ensureThread(ctx, client, cmd)
	if err != nil {
		cleanup()
		return nil, err
	}
	a.activeMu.Lock()
	active.threadID = threadID
	cancelled := active.cancelled
	a.activeMu.Unlock()
	if cancelled {
		cleanup()
		return closedChunkStream(Chunk{Kind: protocol.KindFinal, IsFinal: true}), nil
	}

	usageBaseline := client.threadUsageTotal(threadID)
	if cmd.ExternalID == "" {
		usageBaseline = zeroCodexUsage()
	}
	result, err := client.request(ctx, "turn/start", a.turnStartParams(threadID, cmd))
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("codex turn/start: %w", err)
	}
	turnID, err := responseObjectID(result, "turn")
	if err != nil {
		cleanup()
		return nil, fmt.Errorf("codex turn/start response: %w", err)
	}
	a.activeMu.Lock()
	active.turnID = turnID
	a.activeMu.Unlock()
	active.readyOnce.Do(func() { close(active.ready) })

	out := make(chan Chunk, 64)
	state := &codexAppEventState{
		turnID:        turnID,
		fileEdits:     newFileEditState(),
		usageBaseline: usageBaseline,
	}
	go func() {
		defer close(out)
		defer cleanup()
		meta := map[string]any{}
		if selected, _ := cmd.Options[protocol.OptionModel].(string); selected != "" {
			resolvedModel = selected
			a.rememberModel(threadID, selected)
		}
		if resolvedModel != "" {
			meta["model"] = resolvedModel
		}
		externalID := ""
		if cmd.ExternalID == "" {
			externalID = threadID
		}
		out <- Chunk{Kind: protocol.KindProgress, Content: "turn started", Meta: meta, ExternalID: externalID}
		for {
			ev, ok, endErr := client.nextEvent(ctx)
			if !ok {
				// The connection died or the command context was cancelled
				// without a cooperative turn/completed. cleanup() closes the
				// connection, so the stream always reaches a terminal chunk
				// instead of waiting on app-server forever.
				cleanup()
				out <- codexTerminalChunk(endErr)
				return
			}
			chunks := mapCodexAppEvent(ev, state)
			terminal := ev.method == "turn/completed"
			if terminal {
				// Release the writer before Argus can observe a terminal chunk
				// and advertise this session as idle.
				cleanup()
			}
			for _, chunk := range chunks {
				out <- chunk
			}
			if terminal {
				return
			}
		}
	}()
	return out, nil
}

// codexTerminalChunk closes out a turn that ended without a turn/completed.
// A cancelled command is a normal outcome and reports a plain final chunk,
// matching the cooperative interrupt path; anything else surfaces the reason
// the connection died.
func codexTerminalChunk(err error) Chunk {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return Chunk{Kind: protocol.KindFinal, IsFinal: true}
	}
	return Chunk{Kind: protocol.KindError, Content: err.Error(), IsFinal: true}
}

func closedChunkStream(chunk Chunk) <-chan Chunk {
	out := make(chan Chunk, 1)
	out <- chunk
	close(out)
	return out
}

func (a *CodexAdapter) Cancel(ctx context.Context, commandID string) error {
	cancelCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	a.activeMu.Lock()
	active := a.active[commandID]
	if active == nil {
		a.activeMu.Unlock()
		return nil
	}
	active.cancelled = true
	ready := active.ready
	a.activeMu.Unlock()
	select {
	case <-ready:
	case <-cancelCtx.Done():
		return cancelCtx.Err()
	}
	a.activeMu.Lock()
	client, threadID, turnID := active.client, active.threadID, active.turnID
	a.activeMu.Unlock()
	if client == nil || threadID == "" || turnID == "" {
		return nil
	}
	_, err := client.request(cancelCtx, "turn/interrupt", map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
	})
	// Graceful first: app-server finalizes the interrupted turn on disk, so a
	// later resume sees a coherent thread. But never wait on cooperation
	// forever. An app-server that acks the interrupt without emitting
	// turn/completed would otherwise leave the chunk stream open, the command
	// unacked, and the session stuck "running" — so escalate to closing the
	// connection, which shuts stdin and then kills.
	go func() {
		select {
		case <-active.terminated:
		case <-time.After(codexInterruptGrace):
			_ = client.Close()
		}
	}()
	if err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("codex turn/interrupt: %w", err)
	}
	return nil
}

// CloneSession uses app-server's native persisted-history fork. To preserve
// Argus's 1-based turn boundary, read the source turns and pass lastTurnId
// only when the requested boundary excludes later turns.
func (a *CodexAdapter) CloneSession(
	ctx context.Context, _ /* workingDir */, srcExternalID string, turnIndex int,
) (string, error) {
	client, err := startCodexAppServer(ctx, a.binary, a.workingDir, a.extraArgs)
	if err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	defer client.Close()
	read, err := client.request(ctx, "thread/read", map[string]any{
		"threadId": srcExternalID, "includeTurns": true,
	})
	if err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	var history struct {
		Thread struct {
			Turns []struct {
				ID string `json:"id"`
			} `json:"turns"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(read, &history); err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	params := map[string]any{"threadId": srcExternalID}
	if turnIndex > 0 && turnIndex < len(history.Thread.Turns) {
		params["lastTurnId"] = history.Thread.Turns[turnIndex-1].ID
	}
	fork, err := client.request(ctx, "thread/fork", params)
	if err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	newID, err := responseObjectID(fork, "thread")
	if err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	if model := responseString(fork, "model"); model != "" {
		a.rememberModel(newID, model)
	}
	return newID, nil
}

func (a *CodexAdapter) Close() error {
	a.activeMu.Lock()
	clients := make(map[*codexAppServer]struct{}, len(a.active))
	for _, active := range a.active {
		if active.client != nil {
			clients[active.client] = struct{}{}
		}
	}
	a.activeMu.Unlock()
	for client := range clients {
		_ = client.Close()
	}
	return nil
}

func (a *CodexAdapter) ensureThread(ctx context.Context, client *codexAppServer, cmd protocol.Command) (string, string, error) {
	if cmd.ExternalID != "" {
		params := a.threadResumeParams(cmd.ExternalID, cmd)
		result, err := client.request(ctx, "thread/resume", params)
		if err != nil {
			return "", "", fmt.Errorf("codex thread/resume %s: %w", cmd.ExternalID, err)
		}
		if model := responseString(result, "model"); model != "" {
			a.rememberModel(cmd.ExternalID, model)
		}
		return cmd.ExternalID, a.rememberedModel(cmd.ExternalID), nil
	}
	result, err := client.request(ctx, "thread/start", a.threadParams(cmd))
	if err != nil {
		return "", "", fmt.Errorf("codex thread/start: %w", err)
	}
	threadID, err := responseObjectID(result, "thread")
	if err != nil {
		return "", "", fmt.Errorf("codex thread/start response: %w", err)
	}
	model := responseString(result, "model")
	if model != "" {
		a.rememberModel(threadID, model)
	}
	return threadID, model, nil
}

func (a *CodexAdapter) rememberModel(threadID, model string) {
	if threadID == "" || model == "" {
		return
	}
	a.modelMu.Lock()
	if a.models == nil {
		a.models = make(map[string]string)
	}
	a.models[threadID] = model
	a.modelMu.Unlock()
}

func (a *CodexAdapter) rememberedModel(threadID string) string {
	a.modelMu.Lock()
	defer a.modelMu.Unlock()
	return a.models[threadID]
}

func (a *CodexAdapter) threadResumeParams(threadID string, cmd protocol.Command) map[string]any {
	params := a.threadParams(cmd)
	delete(params, "serviceName")
	params["threadId"] = threadID
	return params
}

func (a *CodexAdapter) threadParams(cmd protocol.Command) map[string]any {
	params := map[string]any{
		"serviceName": "argus",
	}
	if cwd := runDir(cmd.WorkingDir, a.workingDir); cwd != "" {
		params["cwd"] = cwd
	}
	if model, _ := cmd.Options[protocol.OptionModel].(string); model != "" {
		params["model"] = model
	}
	if speed, _ := cmd.Options[protocol.OptionSpeed].(string); speed == "fast" {
		params["serviceTier"] = "fast"
	}
	if a.fullAuto {
		params["approvalPolicy"] = "never"
	}
	if sandbox := a.threadSandbox(); sandbox != "" {
		params["sandbox"] = sandbox
	}
	return params
}

func (a *CodexAdapter) turnStartParams(threadID string, cmd protocol.Command) map[string]any {
	input := []any{map[string]any{"type": "text", "text": cmd.Prompt}}
	for _, att := range cmd.Attachments {
		if att.LocalPath != "" && strings.HasPrefix(att.Mime, "image/") {
			input = append(input, map[string]any{"type": "localImage", "path": att.LocalPath})
		}
	}
	params := map[string]any{
		"threadId":            threadID,
		"input":               input,
		"clientUserMessageId": cmd.ID,
	}
	if cwd := runDir(cmd.WorkingDir, a.workingDir); cwd != "" {
		params["cwd"] = cwd
	}
	if model, _ := cmd.Options[protocol.OptionModel].(string); model != "" {
		params["model"] = model
	}
	if effort, _ := cmd.Options[protocol.OptionEffort].(string); effort != "" {
		params["effort"] = effort
	}
	if speed, _ := cmd.Options[protocol.OptionSpeed].(string); speed == "fast" {
		params["serviceTier"] = "fast"
	}
	if a.fullAuto {
		params["approvalPolicy"] = "never"
	}
	if sandbox := a.turnSandbox(); sandbox != nil {
		params["sandboxPolicy"] = sandbox
	}
	return params
}

func (a *CodexAdapter) threadSandbox() string {
	if a.sandbox != "" {
		switch a.sandbox {
		case "readOnly":
			return "read-only"
		case "workspaceWrite":
			return "workspace-write"
		case "dangerFullAccess":
			return "danger-full-access"
		default:
			return a.sandbox
		}
	}
	if a.fullAuto {
		return "danger-full-access"
	}
	return ""
}

func (a *CodexAdapter) turnSandbox() map[string]any {
	sandbox := a.threadSandbox()
	switch sandbox {
	case "read-only":
		return map[string]any{"type": "readOnly"}
	case "workspace-write":
		return map[string]any{"type": "workspaceWrite"}
	case "danger-full-access":
		return map[string]any{"type": "dangerFullAccess"}
	default:
		return nil
	}
}

func responseObjectID(raw json.RawMessage, key string) (string, error) {
	var response map[string]json.RawMessage
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", err
	}
	var object struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(response[key], &object); err != nil {
		return "", err
	}
	if object.ID == "" {
		return "", fmt.Errorf("missing %s.id", key)
	}
	return object.ID, nil
}

func responseString(raw json.RawMessage, key string) string {
	var response map[string]json.RawMessage
	if err := json.Unmarshal(raw, &response); err != nil {
		return ""
	}
	var value string
	_ = json.Unmarshal(response[key], &value)
	return value
}

type codexAppEventState struct {
	// turnID scopes the event stream to THIS turn. The connection is
	// turn-scoped, but it is not turn-clean: thread/resume replays a
	// thread/tokenUsage/updated tagged with the PREVIOUS turn's id,
	// carrying pre-turn cumulative totals. Consuming that as if it
	// belonged to this turn derives a baseline of `total - last` when the
	// real baseline is `total`, inflating the turn by one API call.
	// Empty means "accept everything" (unit tests that map events
	// directly).
	turnID             string
	fileEdits          *fileEditState
	usageBaseline      map[string]any
	usageTotal         map[string]any
	usageLast          map[string]any
	modelContextWindow any
}

func mapCodexAppEvent(ev codexAppEvent, state *codexAppEventState) []Chunk {
	var params map[string]any
	dec := json.NewDecoder(strings.NewReader(string(ev.params)))
	dec.UseNumber()
	if err := dec.Decode(&params); err != nil {
		return nil
	}
	// Drop events explicitly tagged for a DIFFERENT turn; keep untagged
	// ones. Filtering on presence (as the old transport did) discarded
	// every notification app-server does not tag — 54 of its 81 server
	// notifications — while still letting a replayed one through under a
	// stale id. Comparing ids instead is what actually scopes the stream.
	if state.turnID != "" {
		if evTurn := eventTurnID(ev.params); evTurn != "" && evTurn != state.turnID {
			return nil
		}
	}
	raw := map[string]any{"method": ev.method, "params": params}
	switch ev.method {
	case "item/agentMessage/delta":
		delta := firstString(params, "delta")
		if delta == "" {
			return nil
		}
		return []Chunk{{Kind: protocol.KindDelta, Delta: delta}}
	case "item/started", "item/completed":
		item := toMap(params["item"])
		if item == nil {
			return nil
		}
		item = normalizeCodexAppItem(item)
		if item["type"] == "agent_message" {
			// The authoritative completed item contains the whole accumulated
			// answer; deltas above already streamed it to Argus.
			return nil
		}
		phase := "item.started"
		if ev.method == "item/completed" {
			phase = "item.completed"
		}
		return mapCodexItem(phase, item, raw, state.fileEdits)
	case "thread/tokenUsage/updated":
		tokenUsage := toMap(params["tokenUsage"])
		if tokenUsage != nil {
			total := toMap(tokenUsage["total"])
			last := toMap(tokenUsage["last"])
			if state.usageBaseline == nil {
				state.usageBaseline = subtractCodexUsage(total, last)
			}
			state.usageTotal = normalizeCodexUsage(subtractCodexUsage(total, state.usageBaseline))
			state.usageLast = normalizeCodexUsage(last)
			state.modelContextWindow = tokenUsage["modelContextWindow"]
		}
		return nil
	case "turn/completed":
		if state.usageTotal != nil {
			raw["usage"] = state.usageTotal
		}
		if state.usageLast != nil {
			raw["lastUsage"] = state.usageLast
		}
		if state.modelContextWindow != nil {
			raw["modelContextWindow"] = state.modelContextWindow
		}
		turn := toMap(params["turn"])
		status := firstString(turn, "status")
		if status == "failed" {
			message := nestedErrorMessage(turn["error"])
			if message == "" {
				message = "Codex turn failed"
			}
			return []Chunk{{Kind: protocol.KindError, Content: message, Meta: raw, IsFinal: true}}
		}
		return []Chunk{{Kind: protocol.KindFinal, Meta: raw, IsFinal: true}}
	case "error":
		message := nestedErrorMessage(params["error"])
		if message == "" {
			message = "Codex app-server error"
		}
		return []Chunk{{Kind: protocol.KindStderr, Content: message, Meta: raw}}
	case "turn/plan/updated":
		return []Chunk{{Kind: protocol.KindProgress, Content: "plan updated", Meta: raw}}
	case codexStderrMethod:
		// Codex diagnostics belong in the transcript, not only in a crash
		// message: an expiring token or a sandbox warning is printed while
		// the turn otherwise proceeds.
		return []Chunk{{Kind: protocol.KindStderr, Content: firstString(params, "line")}}
	}
	return nil
}

func zeroCodexUsage() map[string]any {
	return map[string]any{
		"inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0,
		"reasoningOutputTokens": 0, "totalTokens": 0,
	}
}

func subtractCodexUsage(total, baseline map[string]any) map[string]any {
	if total == nil {
		return nil
	}
	out := make(map[string]any, len(total))
	for _, key := range []string{"inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"} {
		value := numericInt64(total[key]) - numericInt64(baseline[key])
		if value < 0 {
			value = 0
		}
		out[key] = value
	}
	return out
}

func numericInt64(v any) int64 {
	switch n := v.(type) {
	case json.Number:
		value, _ := n.Int64()
		return value
	case float64:
		return int64(n)
	case int:
		return int64(n)
	case int64:
		return n
	}
	return 0
}

func normalizeCodexUsage(usage map[string]any) map[string]any {
	if usage == nil {
		return nil
	}
	return map[string]any{
		"input_tokens":            usage["inputTokens"],
		"cached_input_tokens":     usage["cachedInputTokens"],
		"output_tokens":           usage["outputTokens"],
		"reasoning_output_tokens": usage["reasoningOutputTokens"],
	}
}

func normalizeCodexAppItem(item map[string]any) map[string]any {
	t, _ := item["type"].(string)
	switch t {
	case "agentMessage":
		item["type"] = "agent_message"
	case "commandExecution":
		item["type"] = "command_execution"
		item["aggregated_output"] = item["aggregatedOutput"]
		item["exit_code"] = item["exitCode"]
	case "fileChange":
		item["type"] = "file_change"
	case "webSearch":
		item["type"] = "web_search"
	case "mcpToolCall":
		item["type"] = "tool_call"
		item["name"] = strings.Trim(firstString(item, "server")+"/"+firstString(item, "tool"), "/")
		item["output"] = compactJSON(item["result"])
	case "dynamicToolCall":
		item["type"] = "tool_call"
		item["name"] = firstString(item, "tool")
		item["output"] = compactJSON(item["contentItems"])
	}
	return item
}

func compactJSON(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func nestedErrorMessage(v any) string {
	m := toMap(v)
	if m == nil {
		return ""
	}
	return firstString(m, "message")
}

// mapCodexItem turns an item.* event into chunks. For tool-like items we emit
// a `tool` chunk on `item.started` and a matching `stdout`/`stderr` chunk on
// `item.completed`, with the SAME flat meta keys Claude's mapper uses
// (`id` on the tool, `toolResultFor` on the result). buildTimeline() in the
// web client pairs them by id and renders the pair as one card.
func mapCodexItem(phase string, item, raw map[string]any, state *fileEditState) []Chunk {
	itemType, _ := item["type"].(string)
	itemID, _ := item["id"].(string)

	switch itemType {
	case "agent_message":
		if phase != "item.completed" {
			return nil
		}
		txt := firstString(item, "text", "content", "message")
		if txt == "" {
			return nil
		}
		// Emit as a single delta so the UI's markdown assembler picks it up.
		return []Chunk{{Kind: protocol.KindDelta, Delta: txt}}

	case "command_execution":
		raw_cmd := firstString(item, "command")
		display := unwrapShellCommand(raw_cmd)
		input := map[string]any{"command": display, "_raw": raw_cmd}
		if phase == "item.started" {
			return []Chunk{{
				Kind:    protocol.KindTool,
				Content: fmt.Sprintf("Bash %s", display),
				Meta: map[string]any{
					"tool":  "Bash",
					"input": input,
					"id":    itemID,
				},
			}}
		}
		out := firstString(item, "aggregated_output", "stdout", "output")
		exit := exitCodeFromItem(item)
		kind := protocol.KindStdout
		if exit != 0 {
			kind = protocol.KindStderr
		}
		return []Chunk{{
			Kind:    kind,
			Content: out,
			Meta: map[string]any{
				"toolResultFor": itemID,
				"exitCode":      exit,
			},
		}}

	case "web_search":
		// Codex emits two events for each search:
		//   item.started   — query is "" (action.type == "other")
		//   item.completed — query is populated, with action.{query,queries}
		// We only emit on completion so the tool card carries the actual
		// query; while running, the activity pill's pulsing-dot indicator
		// already conveys "search in progress". Tool name is "WebSearch"
		// so ToolPill's describer renders it as "Searched web for <query>"
		// (same shape Claude Code's web_search tool_use produces).
		if phase != "item.completed" {
			return nil
		}
		query := firstString(item, "query")
		if query == "" {
			if action := toMap(item["action"]); action != nil {
				query = firstString(action, "query")
				if query == "" {
					if qs := toAnySlice(action["queries"]); len(qs) > 0 {
						if s, ok := qs[0].(string); ok {
							query = s
						}
					}
				}
			}
		}
		input := map[string]any{"query": query}
		return []Chunk{{
			Kind:    protocol.KindTool,
			Content: fmt.Sprintf("WebSearch %s", query),
			Meta: map[string]any{
				"tool":  "WebSearch",
				"input": input,
				"id":    itemID,
			},
		}}

	case "tool_call", "tool_use":
		name := firstString(item, "name", "tool")
		args := toMap(item["arguments"])
		if args == nil {
			args = toMap(item["input"])
		}
		if phase == "item.started" {
			return []Chunk{{
				Kind:    protocol.KindTool,
				Content: fmt.Sprintf("%s %s", name, FormatToolArgs(args)),
				Meta: map[string]any{
					"tool":  name,
					"input": args,
					"id":    itemID,
				},
			}}
		}
		// item.completed for a tool_use: emit the captured result so it slots
		// in under the tool card via toolResultFor.
		out := firstString(item, "output", "result", "content")
		if out == "" {
			return nil
		}
		return []Chunk{{
			Kind:    protocol.KindStdout,
			Content: out,
			Meta:    map[string]any{"toolResultFor": itemID},
		}}

	case "file_change":
		// `changes` is an array of {path, kind} entries. We synthesize a
		// distinct tool chunk per change (id = "<itemID>_<index>") so the UI
		// renders one card per touched file, mirroring Claude's Write/Edit
		// tool_use shape.
		changes := toAnySlice(item["changes"])
		if len(changes) == 0 {
			return nil
		}
		out := make([]Chunk, 0, len(changes))
		for i, ch := range changes {
			m := toMap(ch)
			if m == nil {
				continue
			}
			path := firstString(m, "path", "file_path")
			kind, _ := m["kind"].(string)
			toolName := codexFileChangeToolName(kind)
			chunkID := fmt.Sprintf("%s_%d", itemID, i)

			if phase == "item.started" {
				// Snapshot pre-change content (may be empty/missing for adds)
				// so item.completed can emit a unified diff. Snapshots that
				// fail safety checks (binary, too big) are skipped, which
				// cleanly falls back to "<verb> <path>" text.
				state.RememberBefore(chunkID, path)
				out = append(out, Chunk{
					Kind:    protocol.KindTool,
					Content: fmt.Sprintf("%s %s", toolName, path),
					Meta: map[string]any{
						"tool": toolName,
						"input": map[string]any{
							"file_path":   path,
							"change_kind": kind,
						},
						"id": chunkID,
					},
				})
			} else {
				verb := codexFileChangePastVerb(kind)
				resultContent := fmt.Sprintf("%s %s", verb, path)
				resultMeta := map[string]any{"toolResultFor": chunkID}
				diff := firstString(m, "diff")
				if diff == "" {
					diff, _, _ = state.BuildDiff(chunkID, kind)
				}
				if diff != "" {
					resultContent = diff
					resultMeta["isDiff"] = true
					resultMeta["filePath"] = path
					resultMeta["changeKind"] = strings.ToLower(kind)
				}
				out = append(out, Chunk{
					Kind:    protocol.KindStdout,
					Content: resultContent,
					Meta:    resultMeta,
				})
			}
		}
		return out
	}

	// Unknown item type — keep it visible as progress instead of dropping.
	return []Chunk{{Kind: protocol.KindProgress, Content: itemType, Meta: raw}}
}

func codexFileChangeToolName(kind string) string {
	switch strings.ToLower(kind) {
	case "add", "create", "created":
		return "Write"
	case "delete", "deleted", "remove":
		return "Delete"
	case "rename", "move", "moved":
		return "Rename"
	default: // update, modify, edit, …
		return "Edit"
	}
}

func codexFileChangePastVerb(kind string) string {
	switch strings.ToLower(kind) {
	case "add", "create", "created":
		return "created"
	case "delete", "deleted", "remove":
		return "deleted"
	case "rename", "move", "moved":
		return "renamed"
	default:
		return "updated"
	}
}

func toAnySlice(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	return nil
}

func exitCodeFromItem(item map[string]any) int {
	switch v := item["exit_code"].(type) {
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return int(i)
		}
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

// unwrapShellCommand strips the `/bin/<shell> -<flags> '<inner>'` wrapping
// codex applies to every shell tool call, so the UI shows the meaningful
// command (`pwd`) instead of the boilerplate (`/bin/zsh -lc 'pwd'`).
//
// We only unwrap one layer; if the inner command is itself wrapped (codex
// sometimes does `/bin/zsh -lc "bash -lc 'pwd'"`), we recurse once.
func unwrapShellCommand(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	for i := 0; i < 2; i++ {
		next, ok := stripShellWrapper(s)
		if !ok {
			break
		}
		s = next
	}
	return s
}

func stripShellWrapper(s string) (string, bool) {
	for _, prefix := range []string{
		"/bin/zsh -lc ", "/bin/zsh -c ",
		"/bin/bash -lc ", "/bin/bash -c ",
		"/bin/sh -c ",
		"zsh -lc ", "zsh -c ",
		"bash -lc ", "bash -c ",
		"sh -c ",
	} {
		if strings.HasPrefix(s, prefix) {
			rest := strings.TrimSpace(s[len(prefix):])
			if unq, ok := unquote(rest); ok {
				return unq, true
			}
			return rest, true
		}
	}
	return s, false
}

func unquote(s string) (string, bool) {
	if len(s) < 2 {
		return s, false
	}
	q := s[0]
	if (q == '\'' || q == '"') && s[len(s)-1] == q {
		return s[1 : len(s)-1], true
	}
	return s, false
}

func firstString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return ""
}

func toMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}
