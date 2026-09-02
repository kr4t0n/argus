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
			if len(p.Input) > 0 && p.Input[0].Text == "slow-start" {
				time.Sleep(100 * time.Millisecond)
			}
			write(map[string]any{"id": *req.ID, "result": map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress"}}})
			if len(p.Input) == 0 || (p.Input[0].Text != "wait" && p.Input[0].Text != "slow-start") {
				write(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"threadId": p.ThreadID, "turnId": turnID, "itemId": "answer", "delta": "hello"}})
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
			write(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": p.ThreadID, "turn": map[string]any{"id": p.TurnID, "status": "interrupted"}}})
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
	dir := t.TempDir()
	logPath := filepath.Join(dir, "requests.jsonl")
	shim := filepath.Join(dir, "codex")
	script := fmt.Sprintf("#!/bin/sh\n%s=1 ARGUS_CODEX_APP_SERVER_LOG=%q exec %q -test.run=TestCodexAppServerHelperProcess\n", codexAppServerHelperEnv, logPath, os.Args[0])
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
	delta := mapCodexAppEvent(codexAppEvent{method: "item/agentMessage/delta", params: mustJSON(map[string]any{"turnId": "t", "delta": "hi"})}, state)
	if len(delta) != 1 || delta[0].Delta != "hi" {
		t.Fatalf("delta mapping = %+v", delta)
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
	var chunks []Chunk
	timer := time.NewTimer(5 * time.Second)
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
