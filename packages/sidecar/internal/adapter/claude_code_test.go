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
	chunks := mapClaudeLine(line, nil, nil, "")

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
	chunks := mapClaudeLine(line, nil, nil, "")

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

// TestMapClaudeUnknownSystemSubtype pins the deliberate fall-through: system
// events with subtypes we don't handle yet must stay VISIBLE (Content ==
// "system") — that junk row is the observability breadcrumb that tells us a
// new event shape appeared and is worth handling explicitly.
func TestMapClaudeUnknownSystemSubtype(t *testing.T) {
	line := `{"type":"system","subtype":"some_future_event","session_id":"s1"}`
	chunks := mapClaudeLine(line, nil, nil, "")

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
	chunks := mapClaudeLine(line, nil, nil, "")

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
	chunks := mapClaudeLine(line, nil, nil, "")

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
	chunks := mapClaudeLine(line, nil, nil, "")

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
	chunks := mapClaudeLine(line, nil, nil, "")

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
		nil, nil, "",
	)
	if len(topLevel) != 1 || topLevel[0].Meta != nil {
		t.Fatalf("top-level text must carry no meta, got %+v", topLevel)
	}
}
