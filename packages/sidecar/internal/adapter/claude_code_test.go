package adapter

import (
	"testing"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// TestMapClaudeThinkingTokens verifies the `system`/`thinking_tokens` event
// is recognized: it must NOT fall through to the generic progress chunk
// (Content == "system") and must carry the token estimate in Meta with no
// visible content so it never renders as a junk row.
func TestMapClaudeThinkingTokens(t *testing.T) {
	line := `{"type":"system","subtype":"thinking_tokens","uuid":"u1","session_id":"s1","estimated_tokens":13800,"estimated_tokens_delta":150}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Kind != protocol.KindProgress {
		t.Fatalf("want KindProgress, got %q", c.Kind)
	}
	if c.Content != "" {
		t.Fatalf("want empty content (no junk row), got %q", c.Content)
	}
	if got := c.Meta["contentType"]; got != "thinking_tokens" {
		t.Fatalf("want contentType=thinking_tokens, got %v", got)
	}
	if got := c.Meta["estimatedTokens"]; got != int64(13800) {
		t.Fatalf("want estimatedTokens=13800 (int64), got %v (%T)", got, got)
	}
	if got := c.Meta["estimatedTokensDelta"]; got != int64(150) {
		t.Fatalf("want estimatedTokensDelta=150 (int64), got %v (%T)", got, got)
	}
}

// TestMapClaudeAPIRetry verifies the `system`/`api_retry` event is forwarded
// content-less (no junk "system" row in the activity timeline) with the full
// event preserved in Meta.
func TestMapClaudeAPIRetry(t *testing.T) {
	line := `{"type":"system","subtype":"api_retry","uuid":"u1","session_id":"s1",` +
		`"error":"server_error","error_status":502,"attempt":1,"max_retries":10,` +
		`"retry_delay_ms":560.59}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Kind != protocol.KindProgress {
		t.Fatalf("want KindProgress, got %q", c.Kind)
	}
	if c.Content != "" {
		t.Fatalf("want empty content (no junk row), got %q", c.Content)
	}
	if got := c.Meta["subtype"]; got != "api_retry" {
		t.Fatalf("want subtype=api_retry in Meta, got %v", got)
	}
}

// TestMapClaudeVCSStateChanged verifies the `system`/`vcs_state_changed`
// event (new in claude 2.1.217) is forwarded content-less with its
// classification in Meta, so the runner can turn it into a git-changed
// notify without it also rendering as a junk "system" row.
func TestMapClaudeVCSStateChanged(t *testing.T) {
	line := `{"type":"system","subtype":"vcs_state_changed","kind":"push",` +
		`"cwd":"/home/kyle/projects/argus","uuid":"u1","session_id":"s1"}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Kind != protocol.KindProgress {
		t.Fatalf("want KindProgress, got %q", c.Kind)
	}
	if c.Content != "" {
		t.Fatalf("want empty content (no junk row), got %q", c.Content)
	}
	if got := c.Meta["contentType"]; got != "vcs_state_changed" {
		t.Fatalf("want contentType=vcs_state_changed, got %v", got)
	}
	if got := c.Meta["kind"]; got != "push" {
		t.Fatalf("want kind=push, got %v", got)
	}
	if got := c.Meta["cwd"]; got != "/home/kyle/projects/argus" {
		t.Fatalf("want cwd passed through, got %v", got)
	}

	// `kind` is an open set — an unrecognized value must still be
	// forwarded (it means the same thing: something changed, go look),
	// and a kind-less event must not become a junk row either.
	for _, ev := range []string{
		`{"type":"system","subtype":"vcs_state_changed","kind":"bisect"}`,
		`{"type":"system","subtype":"vcs_state_changed"}`,
	} {
		got := mapClaudeLine(ev, nil, nil, nil, "")
		if len(got) != 1 || got[0].Content != "" ||
			got[0].Meta["contentType"] != "vcs_state_changed" {
			t.Fatalf("%s: want one tagged content-less chunk, got %+v", ev, got)
		}
	}
}

// TestMapClaudeCodeChangePublished verifies the `system`/
// `code_change_published` event (new in claude 2.1.217) carries the PR
// binding in Meta and stays content-less. Re-emission for the same URL is
// expected — the mapper is stateless here, so every event maps 1:1 and
// consumers dedupe.
func TestMapClaudeCodeChangePublished(t *testing.T) {
	line := `{"type":"system","subtype":"code_change_published","provider":"github",` +
		`"url":"https://github.com/kr4t0n/argus/pull/36","repo":"kr4t0n/argus",` +
		`"identifier":"36","uuid":"u1","session_id":"s1"}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Kind != protocol.KindProgress {
		t.Fatalf("want KindProgress, got %q", c.Kind)
	}
	if c.Content != "" {
		t.Fatalf("want empty content (no junk row), got %q", c.Content)
	}
	want := map[string]any{
		"contentType": "code_change_published",
		"provider":    "github",
		"url":         "https://github.com/kr4t0n/argus/pull/36",
		"repo":        "kr4t0n/argus",
		"identifier":  "36",
	}
	for k, v := range want {
		if got := c.Meta[k]; got != v {
			t.Fatalf("meta[%q]: want %v, got %v", k, v, got)
		}
	}
	// `identifier` is a *string* on the wire even though it's a PR number;
	// forwarding it as anything else would break clients that build URLs.
	if _, ok := c.Meta["identifier"].(string); !ok {
		t.Fatalf("identifier must stay a string, got %T", c.Meta["identifier"])
	}
}

// TestMapClaudeUnknownSystemSubtype pins the deliberate fall-through: system
// events with subtypes we don't handle yet must stay VISIBLE (Content ==
// "system") — that junk row is the observability breadcrumb that tells us a
// new event shape appeared and is worth handling explicitly.
func TestMapClaudeUnknownSystemSubtype(t *testing.T) {
	line := `{"type":"system","subtype":"some_future_event","session_id":"s1"}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Kind != protocol.KindProgress {
		t.Fatalf("want KindProgress, got %q", c.Kind)
	}
	if c.Content != "system" {
		t.Fatalf("want visible content %q, got %q", "system", c.Content)
	}
}

// TestMapClaudeThinkingBlock verifies an assistant `thinking` content block
// is surfaced as a progress chunk tagged contentType=thinking — and crucially
// NOT as a delta, which would leak the reasoning into the final answer.
func TestMapClaudeThinkingBlock(t *testing.T) {
	line := `{"type":"assistant","message":{"content":[` +
		`{"type":"thinking","thinking":"Let me reason about this.","signature":"sig"},` +
		`{"type":"text","text":"Here is the answer."}` +
		`]}}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 2 {
		t.Fatalf("want 2 chunks, got %d: %+v", len(chunks), chunks)
	}

	think := chunks[0]
	if think.Kind != protocol.KindProgress {
		t.Fatalf("thinking: want KindProgress, got %q", think.Kind)
	}
	if think.Content != "Let me reason about this." {
		t.Fatalf("thinking: unexpected content %q", think.Content)
	}
	if got := think.Meta["contentType"]; got != "thinking" {
		t.Fatalf("thinking: want contentType=thinking, got %v", got)
	}

	answer := chunks[1]
	if answer.Kind != protocol.KindDelta {
		t.Fatalf("answer: want KindDelta, got %q", answer.Kind)
	}
	if answer.Delta != "Here is the answer." {
		t.Fatalf("answer: unexpected delta %q", answer.Delta)
	}
}

// TestMapClaudeRedactedThinking verifies encrypted reasoning becomes a
// flagged placeholder rather than being silently dropped.
func TestMapClaudeRedactedThinking(t *testing.T) {
	line := `{"type":"assistant","message":{"content":[` +
		`{"type":"redacted_thinking","data":"encrypted-blob"}` +
		`]}}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Kind != protocol.KindProgress {
		t.Fatalf("want KindProgress, got %q", c.Kind)
	}
	if c.Meta["contentType"] != "thinking" || c.Meta["redacted"] != true {
		t.Fatalf("want contentType=thinking redacted=true, got %+v", c.Meta)
	}
}

// TestMapClaudeSubAgentThinkingCarriesParent verifies thinking blocks emitted
// inside a sub-agent (Task) run carry parentToolUseId so the UI can scope
// them, mirroring how tool_use/tool_result chunks are tagged.
func TestMapClaudeSubAgentThinkingCarriesParent(t *testing.T) {
	line := `{"type":"assistant","parent_tool_use_id":"tool-42","message":{"content":[` +
		`{"type":"thinking","thinking":"nested reasoning"}` +
		`]}}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	if got := chunks[0].Meta["parentToolUseId"]; got != "tool-42" {
		t.Fatalf("want parentToolUseId=tool-42, got %v", got)
	}
}

// TestMapClaudeSubAgentTextCarriesParent verifies nested assistant TEXT (the
// sub-agent's preamble narration and streamed response) is stamped like every
// other nested chunk kind — unstamped, it leaks into the parent turn's
// thought flow instead of the SubAgentWindow.
func TestMapClaudeSubAgentTextCarriesParent(t *testing.T) {
	line := `{"type":"assistant","parent_tool_use_id":"tool-42","message":{"content":[` +
		`{"type":"text","text":"I'll search the repo first."}` +
		`]}}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")

	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	if chunks[0].Delta != "I'll search the repo first." {
		t.Fatalf("want the text as delta, got %+v", chunks[0])
	}
	if got := chunks[0].Meta["parentToolUseId"]; got != "tool-42" {
		t.Fatalf("want parentToolUseId=tool-42, got %v", got)
	}

	// Top-level text stays meta-less: an empty parent id must NOT stamp
	// (clients treat any non-empty parentToolUseId as nested).
	topLevel := mapClaudeLine(
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`,
		nil, nil, nil, "",
	)
	if len(topLevel) != 1 || topLevel[0].Meta != nil {
		t.Fatalf("top-level text must carry no meta, got %+v", topLevel)
	}
}

// TestMapClaudeTaskNotification verifies the background sub-agent completion
// event surfaces its summary (the sub-agent's final report) attributed to the
// dispatching Task call, and that content-less/unlinked notifications and the
// bookkeeping subtypes stay silent.
func TestMapClaudeTaskNotification(t *testing.T) {
	line := `{"type":"system","subtype":"task_notification","task_id":"bg-1",` +
		`"tool_use_id":"toolu_99","status":"completed","summary":"Found 10 files."}`
	chunks := mapClaudeLine(line, nil, nil, nil, "")
	if len(chunks) != 1 {
		t.Fatalf("want 1 chunk, got %d: %+v", len(chunks), chunks)
	}
	c := chunks[0]
	if c.Kind != protocol.KindProgress || c.Content != "Found 10 files." {
		t.Fatalf("want progress with summary content, got %+v", c)
	}
	if c.Meta["contentType"] != "task_notification" || c.Meta["tool_use_id"] != "toolu_99" ||
		c.Meta["status"] != "completed" {
		t.Fatalf("bad meta: %v", c.Meta)
	}

	// No summary → no signal → dropped.
	if got := mapClaudeLine(
		`{"type":"system","subtype":"task_notification","tool_use_id":"toolu_99"}`,
		nil, nil, nil, "",
	); len(got) != 0 {
		t.Fatalf("summary-less notification must be dropped, got %+v", got)
	}

	// Bookkeeping subtypes stay content-less (never a junk system row).
	for _, sub := range []string{"task_updated", "background_tasks_changed"} {
		got := mapClaudeLine(`{"type":"system","subtype":"`+sub+`","tasks":[]}`, nil, nil, nil, "")
		if len(got) != 1 || got[0].Content != "" || got[0].Kind != protocol.KindProgress {
			t.Fatalf("%s: want one content-less progress chunk, got %+v", sub, got)
		}
	}
}

// TestMapClaudeCompactFlow verifies the /compact stream shape (established
// against live claude 2.1.210 captures): compact_boundary → labelled progress
// chunk with before/after context sizes in Meta; status events → content-less;
// the summary user message that follows the boundary → compact_summary; the
// <local-command-stdout> echo and unrelated plain-text user events → dropped.
func TestMapClaudeCompactFlow(t *testing.T) {
	compact := &compactState{}

	boundary := mapClaudeLine(
		`{"type":"system","subtype":"compact_boundary","compact_metadata":{`+
			`"trigger":"manual","pre_tokens":25829,"post_tokens":1854,`+
			`"cumulative_dropped_tokens":23975,"duration_ms":32161}}`,
		nil, nil, compact, "")
	if len(boundary) != 1 {
		t.Fatalf("boundary: want 1 chunk, got %+v", boundary)
	}
	b := boundary[0]
	if b.Kind != protocol.KindProgress || b.Content != "Compacted 25.8k → 1.9k tokens" {
		t.Fatalf("boundary: unexpected chunk %+v", b)
	}
	if b.Meta["contentType"] != "compact_boundary" ||
		b.Meta["preTokens"] != int64(25829) || b.Meta["postTokens"] != int64(1854) ||
		b.Meta["droppedTokens"] != int64(23975) || b.Meta["trigger"] != "manual" {
		t.Fatalf("boundary: bad meta %+v", b.Meta)
	}

	status := mapClaudeLine(
		`{"type":"system","subtype":"status","status":"compacting"}`, nil, nil, nil, "")
	if len(status) != 1 || status[0].Content != "" || status[0].Meta["status"] != "compacting" {
		t.Fatalf("status: want content-less w/ meta, got %+v", status)
	}
	done := mapClaudeLine(
		`{"type":"system","subtype":"status","status":null,"compact_result":"success"}`,
		nil, nil, nil, "")
	if len(done) != 1 || done[0].Content != "" || done[0].Meta["compactResult"] != "success" {
		t.Fatalf("status done: got %+v", done)
	}

	// The injected summary follows the boundary as a plain-text user event.
	summary := mapClaudeLine(
		`{"type":"user","message":{"role":"user","content":"This session is being continued. SUMMARY."}}`,
		nil, nil, compact, "")
	if len(summary) != 1 || summary[0].Meta["contentType"] != "compact_summary" ||
		summary[0].Content != "This session is being continued. SUMMARY." {
		t.Fatalf("summary: got %+v", summary)
	}

	// The slash-command echo is dropped, and a second plain-text user
	// event no longer captures (the flag is single-shot).
	if got := mapClaudeLine(
		`{"type":"user","message":{"content":"<local-command-stdout>Compacted </local-command-stdout>"}}`,
		nil, nil, compact, ""); len(got) != 0 {
		t.Fatalf("local-command echo must drop, got %+v", got)
	}
	if got := mapClaudeLine(
		`{"type":"user","message":{"content":"any other injected text"}}`,
		nil, nil, compact, ""); len(got) != 0 {
		t.Fatalf("plain user text without pending flag must drop, got %+v", got)
	}
}

// TestMapClaudeAutoCompactSummary verifies the auto-compaction wire shape
// (claude 2.1.210): the engine normalizer rewraps the summary's string
// content as [{type:"text",...}] blocks, unlike the manual path's plain
// string. tool_result arrays in between must not consume the pending flag,
// and text arrays without a pending flag stay dropped.
func TestMapClaudeAutoCompactSummary(t *testing.T) {
	compact := &compactState{}

	boundary := mapClaudeLine(
		`{"type":"system","subtype":"compact_boundary","compact_metadata":{`+
			`"trigger":"auto","pre_tokens":1000194,"post_tokens":11830,`+
			`"cumulative_dropped_tokens":988364,"duration_ms":172147}}`,
		nil, nil, compact, "")
	if len(boundary) != 1 || boundary[0].Meta["trigger"] != "auto" {
		t.Fatalf("boundary: got %+v", boundary)
	}

	// A tool_result array between boundary and summary maps as usual and
	// leaves the flag armed.
	state := newFileEditState()
	tasks := &taskListState{}
	toolRes := mapClaudeLine(
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok"}]}}`,
		state, tasks, compact, "")
	if len(toolRes) != 1 || toolRes[0].Kind != protocol.KindStdout {
		t.Fatalf("tool_result: got %+v", toolRes)
	}

	summary := mapClaudeLine(
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"This session is being continued. AUTO SUMMARY."}]}}`,
		state, tasks, compact, "")
	if len(summary) != 1 || summary[0].Kind != protocol.KindProgress ||
		summary[0].Meta["contentType"] != "compact_summary" ||
		summary[0].Content != "This session is being continued. AUTO SUMMARY." {
		t.Fatalf("array summary: got %+v", summary)
	}

	// Single-shot: a later text-block user event must not capture.
	if got := mapClaudeLine(
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"later injected text"}]}}`,
		state, tasks, compact, ""); len(got) != 0 {
		t.Fatalf("text array without pending flag must drop, got %+v", got)
	}
}
