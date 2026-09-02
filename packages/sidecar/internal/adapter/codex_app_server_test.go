package adapter

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

const codexAppServerHelperEnv = "ARGUS_CODEX_APP_SERVER_HELPER"

// TestCodexAppServerHelperProcess is re-executed behind a tiny shell shim so
// it can act like `codex app-server --stdio` for adapter integration tests.
func TestCodexAppServerHelperProcess(t *testing.T) {
	if os.Getenv(codexAppServerHelperEnv) != "1" {
		return
	}
	logPath := os.Getenv("ARGUS_CODEX_APP_SERVER_LOG")
	turn := 0
	// Set by the "wait-hang" prompt: acknowledge turn/interrupt but never
	// emit turn/completed, the uncooperative case a cooperative fake cannot
	// express.
	hangOnInterrupt := false
	appendLog := func(line string) {
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			_, _ = fmt.Fprintln(f, line)
			_ = f.Close()
		}
	}
	write := func(v any) {
		b, _ := json.Marshal(v)
		fmt.Println(string(b))
	}
	// Mirrors the real app-server, which logs colourised tracing diagnostics
	// at startup (a missing-bubblewrap warning) and a broken-pipe line on
	// every teardown. Emitting before `initialize` also keeps the assertion
	// off a stdout/stderr pipe race.
	if os.Getenv("ARGUS_CODEX_FAKE_STDERR") == "1" {
		fmt.Fprintln(os.Stderr, "\x1b[2m2026-01-01T00:00:00Z\x1b[0m \x1b[31mERROR\x1b[0m \x1b[2mcodex_app_server\x1b[0m: bubblewrap not found")
		fmt.Fprintln(os.Stderr, "Failed to write to stdout: Broken pipe (os error 32)")
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		appendLog(line)
		var req struct {
			ID     *int64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.Unmarshal([]byte(line), &req)
		switch req.Method {
		case "initialize":
			write(map[string]any{"id": *req.ID, "result": map[string]any{"userAgent": "fake"}})
		case "thread/start":
			write(map[string]any{"id": *req.ID, "result": map[string]any{"model": "gpt-test", "thread": map[string]any{"id": "thr-1"}}})
		case "thread/resume":
			var p struct {
				ThreadID string `json:"threadId"`
			}
			_ = json.Unmarshal(req.Params, &p)
			write(map[string]any{"id": *req.ID, "result": map[string]any{"model": "gpt-test", "thread": map[string]any{"id": p.ThreadID}}})
		case "turn/start":
			turn++
			turnID := fmt.Sprintf("turn-%d", turn)
			var p struct {
				ThreadID string `json:"threadId"`
				Input    []struct {
					Text string `json:"text"`
				} `json:"input"`
			}
			_ = json.Unmarshal(req.Params, &p)
			prompt := ""
			if len(p.Input) > 0 {
				prompt = p.Input[0].Text
			}
			if prompt == "slow-start" {
				time.Sleep(100 * time.Millisecond)
			}
			if prompt == "wait-hang" {
				hangOnInterrupt = true
			}
			write(map[string]any{"id": *req.ID, "result": map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress"}}})
			if prompt != "wait" && prompt != "slow-start" && prompt != "wait-hang" {
				// Real app-server streams the answer token-by-token AND
				// closes with the authoritative item. Argus takes the item
				// and drops the deltas, so the fake must send both.
				write(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": p.ThreadID, "turnId": turnID, "itemId": "answer", "delta": "hel"}})
				write(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": p.ThreadID, "turnId": turnID, "itemId": "answer", "delta": "lo"}})
				write(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": p.ThreadID, "turnId": turnID, "item": map[string]any{"type": "agentMessage", "id": "answer", "text": "hello"}}})
				write(map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": p.ThreadID, "turnId": turnID, "tokenUsage": map[string]any{
					"total": map[string]any{"inputTokens": 100, "cachedInputTokens": 40, "outputTokens": 20, "reasoningOutputTokens": 5, "totalTokens": 120},
					"last":  map[string]any{"inputTokens": 80, "cachedInputTokens": 30, "outputTokens": 10, "reasoningOutputTokens": 2, "totalTokens": 90},
				}}})
				write(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": p.ThreadID, "turn": map[string]any{"id": turnID, "status": "completed"}}})
			}
		case "turn/interrupt":
			var p struct {
				ThreadID string `json:"threadId"`
				TurnID   string `json:"turnId"`
			}
			_ = json.Unmarshal(req.Params, &p)
			write(map[string]any{"id": *req.ID, "result": map[string]any{}})
			if !hangOnInterrupt {
				write(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": p.ThreadID, "turn": map[string]any{"id": p.TurnID, "status": "interrupted"}}})
			}
		case "thread/read":
			write(map[string]any{"id": *req.ID, "result": map[string]any{"thread": map[string]any{"id": "thr-source", "turns": []any{map[string]any{"id": "old-1"}, map[string]any{"id": "old-2"}, map[string]any{"id": "old-3"}}}}})
		case "thread/fork":
			write(map[string]any{"id": *req.ID, "result": map[string]any{"thread": map[string]any{"id": "thr-fork"}}})
		}
	}
	appendLog(`{"method":"__exited"}`)
	os.Exit(0)
}

func newFakeCodexAdapter(t *testing.T) (*CodexAdapter, string) {
	t.Helper()
	return newFakeCodexAdapterEnv(t, "")
}

func newFakeCodexAdapterEnv(t *testing.T, extraEnv string) (*CodexAdapter, string) {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "requests.jsonl")
	shim := filepath.Join(dir, "codex")
	script := fmt.Sprintf("#!/bin/sh\n%s %s=1 ARGUS_CODEX_APP_SERVER_LOG=%q exec %q -test.run=TestCodexAppServerHelperProcess\n", extraEnv, codexAppServerHelperEnv, logPath, os.Args[0])
	if err := os.WriteFile(shim, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	return &CodexAdapter{binary: shim, fullAuto: true, active: make(map[string]*codexActiveTurn)}, logPath
}

func TestCodexAppServerReleasesWriterWhenIdle(t *testing.T) {
	a, logPath := newFakeCodexAdapter(t)
	t.Cleanup(func() { _ = a.Close() })

	first := drainAdapterChunks(t, a, protocol.Command{ID: "cmd-1", Prompt: "first"})
	if got := joinedDeltas(first); got != "hello" {
		t.Fatalf("first turn delta = %q, want hello", got)
	}
	finals := terminalChunks(first)
	if len(finals) != 1 || numericInt64(toMap(finals[0].Meta["usage"])["input_tokens"]) != 100 {
		t.Fatalf("first turn usage = %+v, want app-server total", finals)
	}
	if first[0].ExternalID != "thr-1" {
		t.Fatalf("external id = %q, want thr-1", first[0].ExternalID)
	}
	if first[0].Meta["model"] != "gpt-test" {
		t.Fatalf("resolved model = %#v, want gpt-test", first[0].Meta["model"])
	}
	if countString(requestMethods(t, logPath), "__exited") != 1 {
		t.Fatalf("app-server had not exited when the first turn became terminal")
	}
	second := drainAdapterChunks(t, a, protocol.Command{ID: "cmd-2", ExternalID: "thr-1", Prompt: "second"})
	if got := joinedDeltas(second); got != "hello" {
		t.Fatalf("second turn delta = %q, want hello", got)
	}

	methods := requestMethods(t, logPath)
	if countString(methods, "initialize") != 2 || countString(methods, "thread/start") != 1 {
		t.Fatalf("request methods = %v, want a fresh app-server after the idle boundary", methods)
	}
	if countString(methods, "thread/resume") != 1 {
		t.Fatalf("second app-server did not resume the persisted thread: %v", methods)
	}
}

func TestCodexAppServerIsolatesConcurrentTurns(t *testing.T) {
	a, logPath := newFakeCodexAdapter(t)
	t.Cleanup(func() { _ = a.Close() })
	first, err := a.Execute(context.Background(), protocol.Command{ID: "cmd-wait", Prompt: "wait"})
	if err != nil {
		t.Fatalf("first Execute: %v", err)
	}
	second := drainAdapterChunks(t, a, protocol.Command{ID: "cmd-2", ExternalID: "thr-2", Prompt: "second"})
	if joinedDeltas(second) != "hello" {
		t.Fatalf("second turn chunks = %+v", second)
	}
	if err := a.Cancel(context.Background(), "cmd-wait"); err != nil {
		t.Fatalf("Cancel first: %v", err)
	}
	_ = drainChunkChannel(t, first)
	methods := requestMethods(t, logPath)
	if countString(methods, "initialize") != 2 {
		t.Fatalf("concurrent turns did not get isolated app-servers: %v", methods)
	}
}

func TestCodexCancelUsesTurnInterrupt(t *testing.T) {
	a, logPath := newFakeCodexAdapter(t)
	t.Cleanup(func() { _ = a.Close() })
	chunks, err := a.Execute(context.Background(), protocol.Command{ID: "cmd-wait", Prompt: "wait"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if err := a.Cancel(context.Background(), "cmd-wait"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	got := drainChunkChannel(t, chunks)
	if len(terminalChunks(got)) != 1 || terminalChunks(got)[0].Kind != protocol.KindFinal {
		t.Fatalf("interrupted chunks = %+v, want one final", got)
	}
	if countString(requestMethods(t, logPath), "turn/interrupt") != 1 {
		t.Fatalf("turn/interrupt was not sent")
	}
}

func TestCodexCancelWaitsForTurnStart(t *testing.T) {
	a, logPath := newFakeCodexAdapter(t)
	t.Cleanup(func() { _ = a.Close() })
	type executeResult struct {
		chunks <-chan Chunk
		err    error
	}
	result := make(chan executeResult, 1)
	go func() {
		chunks, err := a.Execute(context.Background(), protocol.Command{ID: "cmd-slow", Prompt: "slow-start"})
		result <- executeResult{chunks: chunks, err: err}
	}()
	waitForRequestMethod(t, logPath, "turn/start")
	if err := a.Cancel(context.Background(), "cmd-slow"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	executed := <-result
	if executed.err != nil {
		t.Fatalf("Execute: %v", executed.err)
	}
	_ = drainChunkChannel(t, executed.chunks)
	methods := requestMethods(t, logPath)
	if countString(methods, "turn/interrupt") != 1 {
		t.Fatalf("turn/interrupt count during turn/start = %d; methods: %v", countString(methods, "turn/interrupt"), methods)
	}
}

// An app-server that acks turn/interrupt but never emits turn/completed must
// not strand the turn: without a forced-termination fallback the chunk stream
// stays open, handleCommand never returns, the command is never acked, and
// the session shows "running" forever.
func TestCodexCancelTerminatesUncooperativeInterrupt(t *testing.T) {
	a, logPath := newFakeCodexAdapter(t)
	t.Cleanup(func() { _ = a.Close() })
	chunks, err := a.Execute(context.Background(), protocol.Command{ID: "cmd-hang", Prompt: "wait-hang"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if err := a.Cancel(context.Background(), "cmd-hang"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	got := drainChunkChannelWithin(t, chunks, 15*time.Second)
	if terminals := terminalChunks(got); len(terminals) != 1 {
		t.Fatalf("chunks = %+v, want exactly one terminal chunk", got)
	}
	if countString(requestMethods(t, logPath), "turn/interrupt") != 1 {
		t.Fatalf("turn/interrupt was not sent before escalating")
	}
}

// The runner cancels the command context right after adapter.Cancel returns
// (machine/runner.go). The app-server process is not bound to that context,
// so the event loop has to honour it explicitly or the stream never closes.
func TestCodexExecuteTerminatesOnContextCancel(t *testing.T) {
	a, _ := newFakeCodexAdapter(t)
	t.Cleanup(func() { _ = a.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	chunks, err := a.Execute(ctx, protocol.Command{ID: "cmd-ctx", Prompt: "wait"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	cancel()
	got := drainChunkChannelWithin(t, chunks, 15*time.Second)
	if terminals := terminalChunks(got); len(terminals) != 1 {
		t.Fatalf("chunks = %+v, want exactly one terminal chunk", got)
	}
}

// Codex diagnostics have to reach the transcript, not just a crash message:
// an expiring token or a sandbox warning is printed to stderr while the turn
// otherwise proceeds, and the operator would see a turn producing nothing.
func TestCodexSurfacesAppServerStderr(t *testing.T) {
	a, _ := newFakeCodexAdapterEnv(t, "ARGUS_CODEX_FAKE_STDERR=1")
	t.Cleanup(func() { _ = a.Close() })
	chunks := drainAdapterChunks(t, a, protocol.Command{ID: "cmd-stderr", Prompt: "hello"})

	var got []string
	for _, c := range chunks {
		if c.Kind == protocol.KindStderr {
			got = append(got, c.Content)
		}
	}
	want := "2026-01-01T00:00:00Z ERROR codex_app_server: bubblewrap not found"
	if len(got) != 1 || got[0] != want {
		t.Fatalf("stderr chunks = %#v, want exactly [%q] (ANSI stripped, teardown noise dropped)", got, want)
	}
	if joinedDeltas(chunks) != "hello" {
		t.Fatalf("stderr must not disturb the answer stream: %+v", chunks)
	}
}

func TestCodexCloneUsesNativeForkBoundary(t *testing.T) {
	a, logPath := newFakeCodexAdapter(t)
	t.Cleanup(func() { _ = a.Close() })
	newID, err := a.CloneSession(context.Background(), "", "thr-source", 2)
	if err != nil {
		t.Fatalf("CloneSession: %v", err)
	}
	if newID != "thr-fork" {
		t.Fatalf("new id = %q, want thr-fork", newID)
	}
	lines := requestLines(t, logPath)
	found := false
	for _, line := range lines {
		if line.Method == "thread/fork" && strings.Contains(string(line.Params), `"lastTurnId":"old-2"`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("thread/fork did not use old-2 boundary: %+v", lines)
	}
}

func TestMapCodexAppServerEvents(t *testing.T) {
	state := &codexAppEventState{fileEdits: newFileEditState(), usageBaseline: zeroCodexUsage()}
	// Token deltas are dropped; the answer comes from item/completed. See
	// TestCodexEmitsWholeAgentMessageNotTokenDeltas.
	delta := mapCodexAppEvent(codexAppEvent{method: "item/agentMessage/delta", params: mustJSON(map[string]any{"turnId": "t", "delta": "hi"})}, state)
	if len(delta) != 0 {
		t.Fatalf("token delta emitted a chunk: %+v", delta)
	}
	answer := mapCodexAppEvent(codexAppEvent{
		method: "item/completed",
		params: mustJSON(map[string]any{
			"turnId": "t",
			"item":   map[string]any{"type": "agentMessage", "id": "m1", "text": "hi"},
		}),
	}, state)
	if len(answer) != 1 || answer[0].Delta != "hi" {
		t.Fatalf("completed message mapping = %+v", answer)
	}
	usage := mapCodexAppEvent(codexAppEvent{
		method: "thread/tokenUsage/updated",
		params: mustJSON(map[string]any{
			"turnId": "t",
			"tokenUsage": map[string]any{
				"total": map[string]any{"inputTokens": 100, "cachedInputTokens": 40, "outputTokens": 20},
				"last":  map[string]any{"inputTokens": 80, "cachedInputTokens": 30, "outputTokens": 10},
			},
		}),
	}, state)
	if len(usage) != 0 {
		t.Fatalf("usage notification unexpectedly emitted chunks: %+v", usage)
	}
	failed := mapCodexAppEvent(codexAppEvent{
		method: "turn/completed",
		params: mustJSON(map[string]any{
			"turn": map[string]any{
				"id": "t", "status": "failed",
				"error": map[string]any{"message": "boom"},
			},
		}),
	}, state)
	if len(failed) != 1 || failed[0].Kind != protocol.KindError || failed[0].Content != "boom" || !failed[0].IsFinal {
		t.Fatalf("failed turn mapping = %+v", failed)
	}
	if got := toMap(failed[0].Meta["usage"])["input_tokens"]; numericInt64(got) != 100 {
		t.Fatalf("final usage input_tokens = %#v, want 100", got)
	}
}

func TestCodexUsageSubtractsThreadBaseline(t *testing.T) {
	state := &codexAppEventState{
		fileEdits: newFileEditState(),
		usageBaseline: map[string]any{
			"inputTokens": 70, "cachedInputTokens": 20, "outputTokens": 5,
		},
	}
	mapCodexAppEvent(codexAppEvent{
		method: "thread/tokenUsage/updated",
		params: mustJSON(map[string]any{
			"turnId": "t",
			"tokenUsage": map[string]any{
				"total": map[string]any{"inputTokens": 100, "cachedInputTokens": 40, "outputTokens": 20},
				"last":  map[string]any{"inputTokens": 25, "cachedInputTokens": 10, "outputTokens": 8},
			},
		}),
	}, state)
	final := mapCodexAppEvent(codexAppEvent{
		method: "turn/completed",
		params: mustJSON(map[string]any{"turn": map[string]any{"id": "t", "status": "completed"}}),
	}, state)
	usage := toMap(final[0].Meta["usage"])
	if numericInt64(usage["input_tokens"]) != 30 || numericInt64(usage["cached_input_tokens"]) != 20 || numericInt64(usage["output_tokens"]) != 15 {
		t.Fatalf("per-turn usage delta = %#v", usage)
	}
}

// thread/resume replays a thread/tokenUsage/updated tagged with the
// PREVIOUS turn's id and carrying pre-turn cumulative totals (verified
// against the real app-server: resuming a used thread emits one right
// after the resume response). Consuming it as this turn's would derive a
// baseline of `total - last` where the real baseline is `total`, inflating
// the turn by one API call and reporting usage before it even starts.
func TestCodexIgnoresPreviousTurnUsageReplay(t *testing.T) {
	state := &codexAppEventState{turnID: "turn-2", fileEdits: newFileEditState()}
	replay := mapCodexAppEvent(codexAppEvent{
		method: "thread/tokenUsage/updated",
		params: mustJSON(map[string]any{
			"threadId": "thr-1",
			"turnId":   "turn-1", // the turn BEFORE this one
			"tokenUsage": map[string]any{
				"total": map[string]any{"inputTokens": 1000, "outputTokens": 100},
				"last":  map[string]any{"inputTokens": 200, "outputTokens": 20},
			},
		}),
	}, state)
	if len(replay) != 0 {
		t.Fatalf("stale usage emitted chunks: %+v", replay)
	}
	if state.usageBaseline != nil || state.usageTotal != nil {
		t.Fatalf("stale usage polluted state: baseline=%v total=%v", state.usageBaseline, state.usageTotal)
	}

	// This turn's own usage still lands.
	mapCodexAppEvent(codexAppEvent{
		method: "thread/tokenUsage/updated",
		params: mustJSON(map[string]any{
			"threadId": "thr-1",
			"turnId":   "turn-2",
			"tokenUsage": map[string]any{
				"total": map[string]any{"inputTokens": 1200, "outputTokens": 130},
				"last":  map[string]any{"inputTokens": 200, "outputTokens": 30},
			},
		}),
	}, state)
	final := mapCodexAppEvent(codexAppEvent{
		method: "turn/completed",
		params: mustJSON(map[string]any{"turn": map[string]any{"id": "turn-2", "status": "completed"}}),
	}, state)
	usage := toMap(final[0].Meta["usage"])
	if numericInt64(usage["input_tokens"]) != 200 || numericInt64(usage["output_tokens"]) != 30 {
		t.Fatalf("per-turn usage = %#v, want the in-turn delta", usage)
	}
}

// An untagged notification must still reach the mapper: 54 of app-server's
// 81 server notifications carry no turnId, so filtering on presence rather
// than on a mismatch would silently drop them.
func TestCodexKeepsUntaggedNotifications(t *testing.T) {
	state := &codexAppEventState{turnID: "turn-2", fileEdits: newFileEditState()}
	got := mapCodexAppEvent(codexAppEvent{
		method: codexStderrMethod,
		params: mustJSON(map[string]any{"line": "sandbox warning"}),
	}, state)
	if len(got) != 1 || got[0].Kind != protocol.KindStderr {
		t.Fatalf("untagged notification dropped: %+v", got)
	}
}

// The fileChange wire shape, captured from a real `codex app-server` turn:
// `kind` is a TAGGED OBJECT, and `changes[].diff` is populated at BOTH
// item.started and item.completed.
//
//	item/started:   keys=[changes id status type]  (no top-level diff)
//	  change: kind={"type":"add"}  diff="hello\n"
func TestCodexFileChangeUsesTaggedKindAndSuppliedDiff(t *testing.T) {
	state := &codexAppEventState{turnID: "t", fileEdits: newFileEditState()}
	item := map[string]any{
		"type": "fileChange", "id": "item-1", "status": "inProgress",
		"changes": []any{map[string]any{
			"path": "/tmp/a.txt", "kind": map[string]any{"type": "add"}, "diff": "hello\n",
		}},
	}
	started := mapCodexAppEvent(codexAppEvent{
		method: "item/started",
		params: mustJSON(map[string]any{"turnId": "t", "item": item}),
	}, state)
	if len(started) != 1 {
		t.Fatalf("started chunks = %+v", started)
	}
	// A tagged-object kind must resolve to Write, not the "Edit" default.
	if got := toMap(started[0].Meta)["tool"]; got != "Write" {
		t.Fatalf("tool = %#v, want Write for kind {type:add}", got)
	}
	if got := toMap(toMap(started[0].Meta)["input"])["change_kind"]; got != "add" {
		t.Fatalf("change_kind = %#v, want add", got)
	}
	// app-server supplied the diff, so no snapshot should have been taken —
	// BuildDiff is the only thing that frees them, and it never runs here.
	if n := len(state.fileEdits.entries); n != 0 {
		t.Fatalf("retained %d unused file snapshot(s)", n)
	}

	item["status"] = "completed"
	completed := mapCodexAppEvent(codexAppEvent{
		method: "item/completed",
		params: mustJSON(map[string]any{"turnId": "t", "item": item}),
	}, state)
	if len(completed) != 1 {
		t.Fatalf("completed chunks = %+v", completed)
	}
	meta := toMap(completed[0].Meta)
	if meta["isDiff"] != true || meta["changeKind"] != "add" {
		t.Fatalf("result meta = %#v, want the supplied diff tagged add", meta)
	}
	if completed[0].Content != "hello\n" {
		t.Fatalf("content = %q, want the app-server diff", completed[0].Content)
	}
}

// The answer must arrive as ONE chunk per message, from item/completed —
// exactly what `codex exec --json` did. app-server also streams the same
// text token-by-token via item/agentMessage/delta (69 deltas for 368 chars
// in a measured turn, ~40/s in a burst); consuming those turned every
// message into ~35x the chunks, each a Redis XADD + Postgres row + WS
// frame + React render.
func TestCodexEmitsWholeAgentMessageNotTokenDeltas(t *testing.T) {
	state := &codexAppEventState{turnID: "t", fileEdits: newFileEditState()}

	for _, d := range []string{"Hel", "lo ", "world"} {
		if got := mapCodexAppEvent(codexAppEvent{
			method: "item/agentMessage/delta",
			params: mustJSON(map[string]any{"turnId": "t", "itemId": "m1", "delta": d}),
		}, state); len(got) != 0 {
			t.Fatalf("token delta emitted a chunk: %+v", got)
		}
	}

	item := map[string]any{"type": "agentMessage", "id": "m1", "text": "Hello world"}
	if got := mapCodexAppEvent(codexAppEvent{
		method: "item/started",
		params: mustJSON(map[string]any{"turnId": "t", "item": item}),
	}, state); len(got) != 0 {
		t.Fatalf("agentMessage item.started emitted a chunk: %+v", got)
	}
	got := mapCodexAppEvent(codexAppEvent{
		method: "item/completed",
		params: mustJSON(map[string]any{"turnId": "t", "item": item}),
	}, state)
	if len(got) != 1 || got[0].Kind != protocol.KindDelta || got[0].Delta != "Hello world" {
		t.Fatalf("completed message = %+v, want one delta chunk with the whole text", got)
	}
}

// userMessage is app-server echoing back the prompt Argus sent; reasoning
// belongs in the thinking row, not the generic type-name fallback; and an
// genuinely unknown type stays a breadcrumb but only once.
func TestCodexItemNoiseIsFiltered(t *testing.T) {
	state := &codexAppEventState{turnID: "t", fileEdits: newFileEditState()}
	emit := func(method string, item map[string]any) []Chunk {
		return mapCodexAppEvent(codexAppEvent{
			method: method,
			params: mustJSON(map[string]any{"turnId": "t", "item": item}),
		}, state)
	}

	user := map[string]any{"type": "userMessage", "id": "u1", "content": []any{"hi"}}
	if got := append(emit("item/started", user), emit("item/completed", user)...); len(got) != 0 {
		t.Fatalf("userMessage surfaced: %+v", got)
	}

	// summary/content are ARRAYS of strings — a plain string read yields "".
	reasoning := map[string]any{
		"type": "reasoning", "id": "r1",
		"summary": []any{"Weighing options", "Picking one"},
	}
	if got := emit("item/started", reasoning); len(got) != 0 {
		t.Fatalf("reasoning item.started surfaced: %+v", got)
	}
	got := emit("item/completed", reasoning)
	if len(got) != 1 || got[0].Kind != protocol.KindProgress {
		t.Fatalf("reasoning = %+v, want one progress chunk", got)
	}
	if toMap(got[0].Meta)["contentType"] != "thinking" {
		t.Fatalf("reasoning meta = %#v, want contentType thinking", got[0].Meta)
	}
	if got[0].Content != "Weighing options\n\nPicking one" {
		t.Fatalf("reasoning content = %q, want the joined summary", got[0].Content)
	}
	if empty := emit("item/completed", map[string]any{"type": "reasoning", "id": "r2"}); len(empty) != 0 {
		t.Fatalf("empty reasoning surfaced: %+v", empty)
	}

	// Unknown types stay visible, but once — not on both phases.
	odd := map[string]any{"type": "somethingNew", "id": "x1"}
	if got := emit("item/started", odd); len(got) != 0 {
		t.Fatalf("unknown item.started surfaced: %+v", got)
	}
	if got := emit("item/completed", odd); len(got) != 1 || got[0].Content != "somethingNew" {
		t.Fatalf("unknown item.completed = %+v, want one breadcrumb", got)
	}
}

func drainAdapterChunks(t *testing.T, a Adapter, cmd protocol.Command) []Chunk {
	t.Helper()
	ch, err := a.Execute(context.Background(), cmd)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	return drainChunkChannel(t, ch)
}

func drainChunkChannel(t *testing.T, ch <-chan Chunk) []Chunk {
	t.Helper()
	return drainChunkChannelWithin(t, ch, 5*time.Second)
}

// drainChunkChannelWithin gives cancellation tests room for the interrupt
// grace period plus process teardown, which the default bound is too tight
// for.
func drainChunkChannelWithin(t *testing.T, ch <-chan Chunk, within time.Duration) []Chunk {
	t.Helper()
	var chunks []Chunk
	timer := time.NewTimer(within)
	defer timer.Stop()
	for {
		select {
		case chunk, ok := <-ch:
			if !ok {
				return chunks
			}
			chunks = append(chunks, chunk)
		case <-timer.C:
			t.Fatalf("timed out draining chunks: %+v", chunks)
		}
	}
}

func joinedDeltas(chunks []Chunk) string {
	var b strings.Builder
	for _, chunk := range chunks {
		b.WriteString(chunk.Delta)
	}
	return b.String()
}

type loggedRequest struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func requestLines(t *testing.T, path string) []loggedRequest {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read request log: %v", err)
	}
	var requests []loggedRequest
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var request loggedRequest
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Fatalf("parse request %q: %v", line, err)
		}
		requests = append(requests, request)
	}
	return requests
}

func requestMethods(t *testing.T, path string) []string {
	t.Helper()
	requests := requestLines(t, path)
	methods := make([]string, 0, len(requests))
	for _, request := range requests {
		methods = append(methods, request.Method)
	}
	return methods
}

func countString(values []string, target string) int {
	n := 0
	for _, value := range values {
		if value == target {
			n++
		}
	}
	return n
}

func waitForRequestMethod(t *testing.T, path, method string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil && strings.Contains(string(b), `"method":"`+method+`"`) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", method)
}
