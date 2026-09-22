package adapter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// ClaudeCodeAdapter wraps the `claude` CLI using --output-format stream-json.
// stream-json is an NDJSON stream; the interesting events are:
//
//	{ "type": "system",    "subtype": "init",  "session_id": "..." }  → SessionExternalID
//	{ "type": "assistant", "message": { "content": [ {text}/{tool_use} ] } }
//	{ "type": "user",      "message": { "content": [ {tool_result} ] } }
//	{ "type": "result",    "result": "...", "is_error": bool }         → final
//
// Two defaults differ from interactive `claude`:
//   - dangerouslySkipPermissions=true so tool calls don't wait on TTY prompts
//     (we have no TTY to approve them). Required for headless operation.
//   - --verbose is always on because claude *requires* it when combining
//     --print with --output-format stream-json.
//
// Both can be overridden from the sidecar YAML, and `permissionMode` lets you
// swap --dangerously-skip-permissions for an explicit --permission-mode <m>.
type ClaudeCodeAdapter struct {
	binary                     string
	workingDir                 string
	dangerouslySkipPermissions bool
	permissionMode             string // optional override; takes precedence over the flag
	extraArgs                  []string

	runMu   sync.Mutex
	runners map[string]*CLIRunner // commandID → runner
}

const claudeDefaultBinary = "claude"

func init() {
	Register("claude-code", Plugin{
		DefaultBinary: claudeDefaultBinary,
		Factory: func(cfg map[string]any) (Adapter, error) {
			bin, _ := cfg["binary"].(string)
			if bin == "" {
				bin = claudeDefaultBinary
			}
			if _, err := exec.LookPath(bin); err != nil {
				return nil, fmt.Errorf("claude CLI %q not found: %w", bin, err)
			}
			a := &ClaudeCodeAdapter{
				binary:                     bin,
				workingDir:                 WorkingDirFromCfg(cfg),
				dangerouslySkipPermissions: boolFromCfg(cfg, "dangerouslySkipPermissions", true),
				runners:                    map[string]*CLIRunner{},
			}
			if s, ok := cfg["permissionMode"].(string); ok {
				a.permissionMode = s
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

func (a *ClaudeCodeAdapter) Ping(ctx context.Context) error {
	return exec.CommandContext(ctx, a.binary, "--version").Run()
}

func (a *ClaudeCodeAdapter) Version(ctx context.Context) (string, error) {
	return readBinaryVersion(ctx, a.binary)
}

func (a *ClaudeCodeAdapter) Execute(
	ctx context.Context, cmd protocol.Command,
) (<-chan Chunk, error) {
	// Flag layout (claude [...flags...] [--resume <id>]):
	//   -p / --print                         non-interactive: print & exit
	//   --output-format stream-json          NDJSON stream on stdout
	//   --verbose                            mandatory companion of the above
	//   --dangerously-skip-permissions |     accept all tool calls w/o prompts
	//     --permission-mode <mode>           (mutually exclusive override)
	//   --resume <id>                        resume prior session by id
	//   --model <name>[1m]                   per-command model override;
	//                                        [1m] selects the 1M context window
	//   --effort <level>                     thinking strength (low…max)
	args := []string{
		"-p",
		"--output-format", "stream-json",
		"--verbose",
	}
	switch {
	case a.permissionMode != "":
		args = append(args, "--permission-mode", a.permissionMode)
	case a.dangerouslySkipPermissions:
		args = append(args, "--dangerously-skip-permissions")
	}
	if cmd.ExternalID != "" {
		args = append(args, "--resume", cmd.ExternalID)
	}
	if model, ok := cmd.Options[protocol.OptionModel].(string); ok && model != "" {
		// context="1m" maps to claude's `[1m]` model-string suffix
		// (works on aliases and full names). Don't double-append when
		// the caller already passed a suffixed name via free text.
		if ctxOpt, _ := cmd.Options[protocol.OptionContext].(string); ctxOpt == "1m" &&
			!strings.HasSuffix(model, "[1m]") {
			model += "[1m]"
		}
		args = append(args, "--model", model)
	}
	if effort, ok := cmd.Options[protocol.OptionEffort].(string); ok && effort != "" {
		// Claude Code degrades gracefully (an unsupported level falls
		// back to the highest supported one at or below), so we pass
		// the value through without validating against the model.
		args = append(args, "--effort", effort)
	}
	args = append(args, a.extraArgs...)

	// Per-run state so mapClaudeLine can snapshot file contents at tool_use
	// time and emit a unified diff at the matching tool_result, plus the
	// task-list reconstruction for TaskCreate/TaskUpdate/TaskList. Scoped
	// to this Execute() so we never leak across runs.
	state := newFileEditState()
	tasks := newTaskListState()
	compact := &compactState{}

	dir := runDir(cmd.WorkingDir, a.workingDir)
	spec := StreamSpec{
		Binary:     a.binary,
		Args:       args,
		Stdin:      cmd.Prompt,
		Dir:        dir,
		StderrKind: protocol.KindStderr,
		Mapper: func(line string) []Chunk {
			return mapClaudeLine(line, state, tasks, compact, dir)
		},
	}

	runner, err := Start(ctx, spec)
	if err != nil {
		return nil, err
	}
	a.runMu.Lock()
	a.runners[cmd.ID] = runner
	a.runMu.Unlock()

	// Wrap the runner channel to drop the runner from the map when it's done.
	out := make(chan Chunk, 32)
	go func() {
		defer close(out)
		for c := range runner.Chunks {
			out <- c
		}
		a.runMu.Lock()
		delete(a.runners, cmd.ID)
		a.runMu.Unlock()
	}()
	return out, nil
}

func (a *ClaudeCodeAdapter) Cancel(_ context.Context, commandID string) error {
	a.runMu.Lock()
	runner := a.runners[commandID]
	a.runMu.Unlock()
	if runner != nil {
		runner.Cancel()
	}
	return nil
}

// CloneSession forks Claude Code's on-disk transcript for srcExternalID
// into a new session file. Claude Code stores each session as a single
// JSONL at ~/.claude/projects/<slug>/<sessionId>.jsonl, and EVERY line
// carries a top-level `sessionId` field — so cloning has two parts:
//
//  1. Copy the file under a fresh UUID name in the same project dir.
//  2. Rewrite every line's `sessionId` to the new UUID.
//
// turnIndex is 1-based and counts the server's Command rows — prompts the
// user sent. The clone keeps everything through the end of that turn and
// drops the rest. Which lines make up a turn is claudeCloneCut's job: the
// transcript holds user-typed lines that are not prompts, and counting
// those is exactly how a fork used to land one or more turns short on any
// session that had been compacted.
func (a *ClaudeCodeAdapter) CloneSession(
	_ context.Context, workingDir, srcExternalID string, turnIndex int,
) (string, error) {
	wd := runDir(workingDir, a.workingDir)
	if wd == "" {
		return "", fmtCloneError("claude-code", srcExternalID,
			fmt.Errorf("workingDir not set; cannot derive project slug"))
	}
	home, err := homeDir()
	if err != nil {
		return "", fmtCloneError("claude-code", srcExternalID, err)
	}
	srcFile, err := claudeFindSessionFile(home, wd, srcExternalID)
	if err != nil {
		return "", fmtCloneError("claude-code", srcExternalID, err)
	}
	lines, err := claudeReadTranscript(srcFile)
	if err != nil {
		return "", fmtCloneError("claude-code", srcExternalID, err)
	}
	cut := claudeCloneCut(lines, turnIndex)

	newID := newSessionUUID()
	// Next to the source rather than under a recomputed slug: that is the
	// one directory `--resume` is guaranteed to look in for this workdir.
	dstFile := filepath.Join(filepath.Dir(srcFile), newID+".jsonl")
	out, err := os.OpenFile(dstFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", fmtCloneError("claude-code", srcExternalID, err)
	}

	// Rewrite sessionId by re-encoding the whole line rather than
	// substring-replacing: the id can legitimately appear inside prompt
	// text. UseNumber keeps large integers (timestamps, byte offsets)
	// byte-identical across the round trip, and the encoder leaves `<`
	// alone so slash-command echoes stay exactly as the CLI wrote them.
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	var werr error
	for _, ln := range lines[:cut] {
		dec := json.NewDecoder(bytes.NewReader(ln.raw))
		dec.UseNumber()
		var m map[string]any
		if dec.Decode(&m) != nil {
			continue // undecodable lines were never copied; keep that
		}
		m["sessionId"] = newID
		if werr = enc.Encode(m); werr != nil {
			break
		}
	}
	if cerr := out.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(dstFile)
		return "", fmtCloneError("claude-code", srcExternalID, werr)
	}
	return newID, nil
}

// claudeLineClass is what claudeCloneCut needs to know about a transcript
// line. Claude Code's own transcript readers draw the same distinctions —
// a human turn is a `user` line that is neither `isMeta` nor
// `isCompactSummary` and carries no tool result — and mirroring them is
// what keeps the on-disk count aligned with the server's Command count.
type claudeLineClass uint8

const (
	// Bookkeeping the CLI writes around messages (attachment, last-prompt,
	// ai-title, queue-operation, mode, …) plus anything undecodable. Never
	// counted; transparent when trimming.
	claudeLineOther claudeLineClass = iota
	// A prompt the user sent — one per server Command. The echo of a slash
	// command (`<command-name>/compact…`) counts too: the server dispatched
	// it as a Command like any other prompt.
	claudeLinePrompt
	// Any other conversation line: assistant output, tool feedback,
	// sub-agent sidechain lines, non-boundary system lines. Ends a turn
	// when trimming.
	claudeLineMessage
	// Lines the CLI injects around a compaction or slash command rather
	// than the user typing them: the `compact_boundary` system line, the
	// `isCompactSummary` user line that follows it, `isMeta` caveats and
	// `<local-command-*>` echoes. Never counted, and trimmed off the end of
	// a turn — see claudeCloneCut. Verified against claude 2.1.274: one
	// `/compact` writes four `user` lines (summary, caveat, command echo,
	// stdout echo) for one server Command, an auto-compaction writes one
	// for none.
	claudeLineInjected
)

func claudeClassifyLine(m map[string]any) claudeLineClass {
	if m == nil {
		return claudeLineOther
	}
	switch m["type"] {
	case "assistant":
		return claudeLineMessage
	case "system":
		if sub, _ := m["subtype"].(string); sub == "compact_boundary" {
			return claudeLineInjected
		}
		return claudeLineMessage
	case "user":
		if b, _ := m["isMeta"].(bool); b {
			return claudeLineInjected
		}
		if b, _ := m["isCompactSummary"].(bool); b {
			return claudeLineInjected
		}
		if b, _ := m["isSidechain"].(bool); b {
			return claudeLineMessage
		}
		if _, ok := m["toolUseResult"]; ok {
			return claudeLineMessage
		}
		msg, _ := m["message"].(map[string]any)
		switch content := msg["content"].(type) {
		case string:
			if strings.HasPrefix(content, "<local-command-") {
				return claudeLineInjected
			}
			return claudeLinePrompt
		case []any:
			return claudeClassifyUserBlocks(content)
		default:
			// No structured content (older shape): a prompt, as before.
			return claudeLinePrompt
		}
	default:
		return claudeLineOther
	}
}

// claudeClassifyUserBlocks handles array-form user content. tool_result
// blocks are feedback to the previous assistant turn; text is a prompt
// unless it is a `<local-command-*>` echo; image / document blocks are
// things the user attached, so a prompt too.
func claudeClassifyUserBlocks(blocks []any) claudeLineClass {
	if len(blocks) == 0 {
		return claudeLinePrompt
	}
	for _, b := range blocks {
		item, _ := b.(map[string]any)
		switch item["type"] {
		case "tool_result":
			continue
		case "text", "input_text":
			if text, _ := item["text"].(string); strings.HasPrefix(text, "<local-command-") {
				return claudeLineInjected
			}
			return claudeLinePrompt
		default:
			return claudeLinePrompt
		}
	}
	return claudeLineMessage // tool_result blocks only
}

type claudeTranscriptLine struct {
	raw   []byte
	class claudeLineClass
}

// claudeReadTranscript loads a transcript as raw lines plus their class.
// Only the raw bytes are retained — a long session is tens of MB and a
// decoded map is several times its JSON — so the copy loop re-decodes
// each kept line.
func claudeReadTranscript(path string) ([]claudeTranscriptLine, error) {
	var lines []claudeTranscriptLine
	err := readJSONLines(path, func(raw []byte, parsed map[string]any) error {
		lines = append(lines, claudeTranscriptLine{raw: raw, class: claudeClassifyLine(parsed)})
		return nil
	})
	return lines, err
}

// claudeCloneCut returns how many leading lines the clone keeps so that it
// ends with turn turnIndex. Turn N spans from its prompt line to just
// before the (N+1)th prompt — but the lines the CLI injected right before
// that next prompt were written by the NEXT command's process (an
// auto-compaction runs when the next prompt arrives; a manual /compact IS
// the next command), so they belong to the part being cut off and are
// trimmed back to turn N's last conversation line. Bookkeeping lines are
// transparent to that walk, so a compaction that happened MID-turn
// (inside the tool loop, before the final answer) is kept. A turnIndex
// past the last prompt keeps the whole file.
func claudeCloneCut(lines []claudeTranscriptLine, turnIndex int) int {
	seen := 0
	lastPrompt := -1
	end := len(lines)
	for i, ln := range lines {
		if ln.class != claudeLinePrompt {
			continue
		}
		if seen >= turnIndex {
			end = i
			break
		}
		seen++
		lastPrompt = i
	}
	cut := end
trim:
	for i := end - 1; i > lastPrompt; i-- {
		switch lines[i].class {
		case claudeLineInjected:
			cut = i
		case claudeLineOther:
			// transparent
		default:
			break trim
		}
	}
	return cut
}

// mapClaudeLine handles the Claude Code stream-json schema (also used by
// Cursor CLI, which intentionally mirrors it). The `state` and `workingDir`
// args let us snapshot file contents at tool_use time and emit a unified
// diff at the matching tool_result for file-modifying tools (Write/Edit/
// MultiEdit/Delete). `tasks` accumulates TaskCreate/TaskUpdate/TaskList
// traffic so task tool results additionally emit a synthesized TodoWrite
// snapshot chunk (see claude_tasks.go). Pass `state=nil` / `tasks=nil` to
// disable either behaviour.
// compactState carries the one-line memory the compact flow needs: the
// compaction summary arrives as the first text-bearing user event AFTER
// a compact_boundary — a plain string on the manual /compact path, a
// [{type:"text",...}] array on the auto path — with no other marking on
// the event itself.
type compactState struct{ pendingSummary bool }

func (c *compactState) expectSummary() {
	if c != nil {
		c.pendingSummary = true
	}
}

func (c *compactState) takeSummary() bool {
	if c == nil || !c.pendingSummary {
		return false
	}
	c.pendingSummary = false
	return true
}

// textBlocksOnly returns the joined text when every block in a user
// message's content array is a text block — the shape the auto-compact
// summary arrives in. Empty or mixed arrays (tool_result, image, …)
// don't qualify.
func textBlocksOnly(contents []any) (string, bool) {
	if len(contents) == 0 {
		return "", false
	}
	parts := make([]string, 0, len(contents))
	for _, c := range contents {
		item, _ := c.(map[string]any)
		if item["type"] != "text" {
			return "", false
		}
		text, _ := item["text"].(string)
		parts = append(parts, text)
	}
	return strings.Join(parts, "\n"), true
}

// formatTokenCount renders context sizes the way the dashboards do:
// "25.8k" / "412".
func formatTokenCount(n int64) string {
	if n >= 1000 {
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	}
	return fmt.Sprintf("%d", n)
}

func mapClaudeLine(line string, state *fileEditState, tasks *taskListState, compact *compactState, workingDir string) []Chunk {
	ev := TryParseJSON(line)
	if ev == nil {
		return []Chunk{{Kind: protocol.KindDelta, Delta: line}}
	}
	t, _ := ev["type"].(string)
	// Sub-agent (Agent / Task tool) chunks carry `parent_tool_use_id`
	// pointing at the dispatching tool_use. Surface it on every chunk
	// meta we emit so the frontend can group nested tool calls under
	// their parent in the SubAgentWindow card. Empty / missing on
	// top-level chunks.
	parentToolUseID, _ := ev["parent_tool_use_id"].(string)
	switch t {
	case "system":
		sub, _ := ev["subtype"].(string)
		switch sub {
		case "init":
			// first system event carries session_id
			if sid, _ := ev["session_id"].(string); sid != "" {
				return []Chunk{{
					Kind:       protocol.KindProgress,
					Content:    "session initialised",
					Meta:       ev,
					ExternalID: sid,
				}}
			}
		case "task_started", "task_progress":
			// Claude emits `task_started` when it kicks off a sub-agent /
			// tool task, with a one-line `description` of what's about to
			// happen. `task_progress` is the older name some Claude
			// versions still emit for the same shape — collapsed here.
			// Full event (task_id, task_type, tool_use_id, …) stays in
			// Meta so a richer UI can render counters/links if it wants.
			if desc, _ := ev["description"].(string); desc != "" {
				return []Chunk{{Kind: protocol.KindProgress, Content: desc, Meta: ev}}
			}
		case "task_notification":
			// For BACKGROUND sub-agents (Task with run_in_background) this
			// is the completion event, and `summary` carries the
			// sub-agent's full final report — the Task tool_result itself
			// is only launch boilerplate in that flow (verified against
			// claude 2.1.210 stream captures). `tool_use_id` points at the
			// dispatching Task call, so clients attach the summary as the
			// sub-agent card's real result. meta.tool_use_id also makes
			// older clients drop it from the main timeline (the same rule
			// that dedups task_started narration) — graceful degradation,
			// no double-render. Notifications without a summary or task
			// linkage carry no signal and stay dropped.
			summary, _ := ev["summary"].(string)
			toolUseID, _ := ev["tool_use_id"].(string)
			if summary != "" && toolUseID != "" {
				meta := map[string]any{
					"contentType": "task_notification",
					"tool_use_id": toolUseID,
				}
				if s, _ := ev["status"].(string); s != "" {
					meta["status"] = s
				}
				return []Chunk{{Kind: protocol.KindProgress, Content: summary, Meta: meta}}
			}
			return nil
		case "task_updated", "background_tasks_changed":
			// Background-task bookkeeping (title/status changes, the live
			// task roster). No user-facing content of its own — the
			// interesting signal (the completion summary) arrives via
			// task_notification above. Content-less so it never renders as
			// a junk "system" row; the full event rides in Meta.
			return []Chunk{{Kind: protocol.KindProgress, Meta: ev}}
		case "compact_boundary":
			// Manual /compact or threshold auto-compaction: the CLI
			// replaced the conversation history with a summary.
			// compact_metadata carries before/after context sizes — the
			// UI renders a transcript divider and snaps the context
			// ring to postTokens (the compact turn's own result
			// reports zero usage, so without this the ring would sit
			// stale until the next real turn).
			meta := map[string]any{"contentType": "compact_boundary"}
			var pre, post int64
			if cm, ok := ev["compact_metadata"].(map[string]any); ok {
				if v, ok := jsonNumberToInt64(cm["pre_tokens"]); ok {
					meta["preTokens"] = v
					pre = v
				}
				if v, ok := jsonNumberToInt64(cm["post_tokens"]); ok {
					meta["postTokens"] = v
					post = v
				}
				if v, ok := jsonNumberToInt64(cm["cumulative_dropped_tokens"]); ok {
					meta["droppedTokens"] = v
				}
				if v, ok := jsonNumberToInt64(cm["duration_ms"]); ok {
					meta["durationMs"] = v
				}
				if s, _ := cm["trigger"].(string); s != "" {
					meta["trigger"] = s
				}
			}
			compact.expectSummary()
			return []Chunk{{
				Kind:    protocol.KindProgress,
				Content: fmt.Sprintf("Compacted %s → %s tokens", formatTokenCount(pre), formatTokenCount(post)),
				Meta:    meta,
			}}
		case "status":
			// Compaction lifecycle ("compacting" → compact_result) and
			// any future status pulses. Content-less so it never
			// renders as a junk system row; clients read meta for a
			// live "Compacting…" state.
			meta := map[string]any{"contentType": "status"}
			if s, _ := ev["status"].(string); s != "" {
				meta["status"] = s
			}
			if s, _ := ev["compact_result"].(string); s != "" {
				meta["compactResult"] = s
			}
			return []Chunk{{Kind: protocol.KindProgress, Meta: meta}}
		case "api_retry":
			// Emitted when an API call fails with a retryable error (e.g.
			// a 502) and Claude Code is about to back off and retry; can
			// fire several times per turn (attempt/max_retries/error_status/
			// retry_delay_ms ride in the event). Forwarded content-less so
			// it never renders as a junk "system" row, with the full event
			// in Meta should a UI want to surface retry status. Unknown
			// subtypes intentionally keep falling through to the visible
			// generic chunk below — that junk row is how we notice new
			// event shapes worth handling.
			return []Chunk{{Kind: protocol.KindProgress, Meta: ev}}
		case "thinking_tokens":
			// Newer Claude Code emits this repeatedly while extended
			// thinking is in progress: `estimated_tokens` is the running
			// total of thinking tokens so far, `estimated_tokens_delta` the
			// increment since the last event (fires roughly every ~150
			// tokens). We forward it as a *content-less* progress chunk so
			// it never renders as a junk "system" row, while the estimate
			// rides in Meta for the UI to surface as a live "Thinking… N
			// tokens" counter. The actual reasoning text arrives separately
			// as `thinking` content blocks on assistant messages (below).
			meta := map[string]any{"contentType": "thinking_tokens"}
			if v, ok := jsonNumberToInt64(ev["estimated_tokens"]); ok {
				meta["estimatedTokens"] = v
			}
			if v, ok := jsonNumberToInt64(ev["estimated_tokens_delta"]); ok {
				meta["estimatedTokensDelta"] = v
			}
			return []Chunk{{Kind: protocol.KindProgress, Meta: meta}}

		case "vcs_state_changed":
			// Claude Code 2.1.217+ classifies the git/gh operations it
			// observes in Bash tool output and emits one event per observed
			// `kind` (commit / push / merge / rebase) — so ONE compound
			// command can fire several (`git merge && git push` → two).
			// Deliberately payload-free beyond the classification: it
			// reports that the repo changed, not what it changed to, so
			// consumers re-read state instead of decoding the event.
			// Best-effort — only foreground Bash mutations are observed, dry
			// runs excluded — and `kind` is an open set, so an unrecognized
			// value means exactly what a recognized one means. Both caveats
			// are why this is a breadcrumb, not a state feed.
			//
			// Mapped ONLY to keep it out of the timeline as a junk "system"
			// row. It deliberately does NOT drive a git-changed nudge: the
			// per-workdir gitWatcher reading `.git/HEAD` + `refs/heads/` is
			// the single source of truth for repo state, and this event is a
			// *claim about shell output*, not an observation of the refs.
			// It's also attributed to the session's cwd, so a `git -C
			// ../other` would nudge the wrong repo. Everything it reports
			// that the dashboard renders (commit / merge / rebase) already
			// moves a ref the watcher sees.
			meta := map[string]any{"contentType": "vcs_state_changed"}
			if s, _ := ev["kind"].(string); s != "" {
				meta["kind"] = s
			}
			// The session's cwd, NOT the mutated repo's path: `git -C` or an
			// inner `cd` mutates somewhere else entirely. A hint for
			// logging, never a routing key.
			if s, _ := ev["cwd"].(string); s != "" {
				meta["cwd"] = s
			}
			return []Chunk{{Kind: protocol.KindProgress, Meta: meta}}

		case "code_change_published":
			// The session is now associated with a published pull / merge
			// request. Fires on creation AND whenever the session
			// contributes to an existing one (`gh pr edit/close/ready`,
			// `gh pr checkout`, or a plain push to a branch that already has
			// an open PR), so the SAME url repeats many times in one session
			// — consumers must treat it as idempotent rebinding, not a
			// first-write-wins create.
			//
			// The fields are scraped from the command's captured output (the
			// last PR-shaped URL printed), which includes output the forge
			// CLI didn't write — hook output, or a file catted by the same
			// command. So they are a display hint, never a verified
			// identity: don't route authenticated requests at `url` on the
			// strength of this event. `provider` is an open set; an unknown
			// value is a forge we don't recognize, not an error.
			//
			// Content-less like the rest; the payload rides in Meta for a UI
			// that wants to link a session to its PR.
			meta := map[string]any{"contentType": "code_change_published"}
			for _, k := range []string{"provider", "url", "repo", "identifier"} {
				if s, _ := ev[k].(string); s != "" {
					meta[k] = s
				}
			}
			return []Chunk{{Kind: protocol.KindProgress, Meta: meta}}

		case "dev_intent":
			// Claude Code's classification of what KIND of development this
			// conversation is doing — `{kind: "ios_app"|"android_app",
			// trigger: "<evidence>"}` and nothing else. Pure classification:
			// there is no state to reconcile, no path to route and no id to
			// bind, so it is silenced rather than consumed.
			//
			// It fires at most once per kind per CLI PROCESS, and every Argus
			// turn is a fresh `claude --resume`, so the detector re-folds the
			// resumed transcript at startup: once a session's history holds
			// the evidence pair (for iOS, a `.swift` write plus an Xcode
			// project / UIKit import / simulator command), EVERY later turn
			// re-emits it — ahead of that turn's own `init`, as the first
			// chunk. That is why it is worth mapping: unmapped it becomes the
			// permanent first row of every turn in any session that has ever
			// touched Swift.
			//
			// Both fields are open sets. `kind` is ["ios_app","android_app"]
			// today; `trigger`'s declared enum is wider than the detectors can
			// currently produce (`swift_edit` / `kotlin_edit` / `java_edit` are
			// declared but unreached), and a second emitter that scans the
			// workspace rather than the transcript reports `project_scan`.
			meta := map[string]any{"contentType": "dev_intent"}
			for _, k := range []string{"kind", "trigger"} {
				if s, _ := ev[k].(string); s != "" {
					meta[k] = s
				}
			}
			return []Chunk{{Kind: protocol.KindProgress, Meta: meta}}
		}
		return []Chunk{{Kind: protocol.KindProgress, Content: t, Meta: ev}}

	case "assistant":
		msg, _ := ev["message"].(map[string]any)
		contents, _ := msg["content"].([]any)
		out := []Chunk{}
		for _, c := range contents {
			item, _ := c.(map[string]any)
			switch item["type"] {
			case "text":
				if s, _ := item["text"].(string); s != "" {
					// Nested sub-agent text (the sub-agent's preamble
					// narration and streamed response) must carry the
					// parent id like every other nested chunk kind, or
					// the clients can't scope it to the SubAgentWindow
					// and it leaks into the parent turn's thought flow.
					var meta map[string]any
					if parentToolUseID != "" {
						meta = map[string]any{"parentToolUseId": parentToolUseID}
					}
					out = append(out, Chunk{Kind: protocol.KindDelta, Delta: s, Meta: meta})
				}
			case "thinking":
				// Extended-thinking reasoning block. The text lives in the
				// `thinking` field (not `text`); `signature` is dropped. We
				// surface it as a progress chunk tagged contentType=thinking
				// — NOT a delta — because post-tool deltas get concatenated
				// into the visible final answer (see splitDeltas), and we
				// must not let private reasoning leak into the reply.
				if s, _ := item["thinking"].(string); s != "" {
					meta := map[string]any{"contentType": "thinking"}
					if parentToolUseID != "" {
						meta["parentToolUseId"] = parentToolUseID
					}
					out = append(out, Chunk{Kind: protocol.KindProgress, Content: s, Meta: meta})
				}
			case "redacted_thinking":
				// Encrypted reasoning the API won't expose in cleartext. We
				// can't render it, but we still emit a placeholder so the UI
				// shows that the model thought here rather than silently
				// dropping the block.
				meta := map[string]any{"contentType": "thinking", "redacted": true}
				if parentToolUseID != "" {
					meta["parentToolUseId"] = parentToolUseID
				}
				out = append(out, Chunk{Kind: protocol.KindProgress, Content: "[redacted thinking]", Meta: meta})
			case "tool_use":
				name, _ := item["name"].(string)
				input, _ := item["input"].(map[string]any)
				toolID, _ := item["id"].(string)

				// Snapshot the file *now* if this is a write-style tool, so
				// the matching tool_result can emit a unified diff. Cheap
				// no-op for Bash/Grep/etc. since they don't carry a path.
				if path := claudeFilePathFromInput(input); path != "" && isFileEditTool(name) {
					state.RememberBefore(toolID, resolveFilePath(workingDir, path))
				}

				// Task-list tools are applied at result time (TaskCreate's
				// assigned id only appears in the result text), so just
				// stash the call here.
				tasks.RememberCall(toolID, name, input)

				meta := map[string]any{"tool": name, "input": input, "id": toolID}
				if parentToolUseID != "" {
					meta["parentToolUseId"] = parentToolUseID
				}
				out = append(out, Chunk{
					Kind:    protocol.KindTool,
					Content: fmt.Sprintf("%s %s", name, FormatToolArgs(input)),
					Meta:    meta,
				})
			}
		}
		if len(out) == 0 {
			return []Chunk{{Kind: protocol.KindProgress, Meta: ev}}
		}
		return out

	case "user":
		msg, _ := ev["message"].(map[string]any)
		// Plain-text user events (string content, no tool_result
		// blocks). Two shapes matter: the compaction summary the CLI
		// injects right after a compact_boundary (kept — it is what
		// future turns actually know about the compacted past, shown
		// as a collapsed transcript row), and <local-command-stdout>
		// slash-command echoes (noise, dropped). Anything else — e.g.
		// injected task notifications — stays dropped as before.
		if text, ok := msg["content"].(string); ok {
			if strings.HasPrefix(text, "<local-command-") {
				return nil
			}
			if compact.takeSummary() {
				return []Chunk{{
					Kind:    protocol.KindProgress,
					Content: text,
					Meta:    map[string]any{"contentType": "compact_summary"},
				}}
			}
			return nil
		}
		contents, _ := msg["content"].([]any)
		// Auto-compaction emits the very same summary message through
		// the engine normalizer, which rewraps string content as
		// [{type:"text",...}] blocks (claude 2.1.210) — so the pending
		// summary can arrive in array form too. tool_result arrays fall
		// through without consuming the flag.
		if text, ok := textBlocksOnly(contents); ok && compact.takeSummary() {
			return []Chunk{{
				Kind:    protocol.KindProgress,
				Content: text,
				Meta:    map[string]any{"contentType": "compact_summary"},
			}}
		}
		out := []Chunk{}
		for _, c := range contents {
			item, _ := c.(map[string]any)
			if item["type"] == "tool_result" {
				toolUseID, _ := item["tool_use_id"].(string)
				isErr, _ := item["is_error"].(bool)
				kind := protocol.KindStdout
				if isErr {
					kind = protocol.KindStderr
				}
				body := stringifyAny(item["content"])
				meta := map[string]any{"toolResultFor": toolUseID}
				if parentToolUseID != "" {
					meta["parentToolUseId"] = parentToolUseID
				}

				// If we snapshotted the file at tool_use, replace the
				// (typically not-very-useful) text body with a unified diff.
				// Errors and missing snapshots leave body untouched.
				if !isErr {
					if diff, path, ok := state.BuildDiff(toolUseID, ""); ok {
						body = diff
						meta["isDiff"] = true
						meta["filePath"] = path
					}
				}

				out = append(out, Chunk{
					Kind:    kind,
					Content: body,
					Meta:    meta,
				})

				// Completed task tool (TaskCreate/TaskUpdate/TaskList):
				// apply the stashed call and follow the result with a
				// synthesized full-list TodoWrite chunk so the dashboard's
				// TodoWindow renders the new Task* tools exactly like the
				// old single-call TodoWrite shape. ":todos" keeps the id
				// distinct from the real tool_use id so the timeline still
				// pairs the real chunk with this result.
				if todos, ok := tasks.ApplyResult(toolUseID, body, isErr); ok {
					todoMeta := map[string]any{
						"tool":        "TodoWrite",
						"input":       map[string]any{"todos": todos},
						"id":          toolUseID + ":todos",
						"synthesized": true,
					}
					if parentToolUseID != "" {
						todoMeta["parentToolUseId"] = parentToolUseID
					}
					out = append(out, Chunk{
						Kind:    protocol.KindTool,
						Content: fmt.Sprintf("TodoWrite %d items", len(todos)),
						Meta:    todoMeta,
					})
				}
			}
		}
		return out

	case "result":
		if isErr, _ := ev["is_error"].(bool); isErr {
			msg, _ := ev["result"].(string)
			if msg == "" {
				msg, _ = ev["error"].(string)
			}
			return []Chunk{{Kind: protocol.KindError, Content: msg, Meta: ev, IsFinal: true}}
		}
		txt, _ := ev["result"].(string)
		return []Chunk{{Kind: protocol.KindFinal, Content: txt, Meta: ev, IsFinal: true}}
	}

	return []Chunk{{Kind: protocol.KindProgress, Meta: ev}}
}

// isFileEditTool reports whether a tool name modifies a file on disk and
// therefore deserves a diff in its result. Used by both Claude Code and
// Cursor CLI mappers; matched case-insensitively because tool names appear
// in both PascalCase ("Write") and snake_case ("write_file").
func isFileEditTool(name string) bool {
	switch strings.ToLower(name) {
	case "write", "create",
		"edit", "patch", "multiedit",
		"delete", "remove", "rm",
		"writefile", "write_file",
		"editfile", "edit_file",
		"applypatch", "apply_patch":
		return true
	}
	return false
}

// claudeFilePathFromInput pulls the filesystem path out of a tool_use input
// map. Different tools use different field names ("file_path" for Claude's
// built-ins, "path" for some Cursor tools, etc.) so we try a small set of
// known keys.
func claudeFilePathFromInput(input map[string]any) string {
	if input == nil {
		return ""
	}
	for _, key := range []string{"file_path", "filePath", "path", "filename", "file"} {
		if s, ok := input[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func stringifyAny(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []any:
		b := ""
		for _, item := range x {
			if m, ok := item.(map[string]any); ok {
				if s, ok := m["text"].(string); ok {
					b += s
				}
			}
		}
		return b
	default:
		if b, err := marshal(v); err == nil {
			return b
		}
		return fmt.Sprintf("%v", v)
	}
}
