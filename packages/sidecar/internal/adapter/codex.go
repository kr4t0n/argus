package adapter

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// CodexAdapter wraps the OpenAI `codex` CLI in non-interactive exec mode.
// The CLI emits NDJSON lines with `msg.type` discriminators. We map them to
// our ResultKind vocabulary; unknown events fall through as `progress`.
//
// Two defaults differ from interactive `codex`:
//   - skipGitRepoCheck=true so working dirs that aren't git repos still run
//   - fullAuto=true so tool calls execute without TTY approval prompts
//
// Both can be flipped from the sidecar YAML, and `sandbox` lets you swap the
// `--full-auto` shorthand for an explicit `--sandbox <mode>`.
type CodexAdapter struct {
	binary           string
	workingDir       string
	skipGitRepoCheck bool
	fullAuto         bool
	sandbox          string // optional override; takes precedence over fullAuto
	extraArgs        []string
	runMu            sync.Mutex
	runs             map[string]*CLIRunner
}

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
				binary:           bin,
				workingDir:       WorkingDirFromCfg(cfg),
				skipGitRepoCheck: boolFromCfg(cfg, "skipGitRepoCheck", true),
				fullAuto:         boolFromCfg(cfg, "fullAuto", true),
				runs:             map[string]*CLIRunner{},
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
	return exec.CommandContext(ctx, a.binary, "--version").Run()
}

func (a *CodexAdapter) Version(ctx context.Context) (string, error) {
	return readBinaryVersion(ctx, a.binary)
}

func (a *CodexAdapter) Execute(
	ctx context.Context, cmd protocol.Command,
) (<-chan Chunk, error) {
	// Flag layout (codex exec [...flags...] [resume <id>] <prompt>):
	//   --json                           NDJSON stream on stdout
	//   --skip-git-repo-check            allow non-git working dirs
	//   --full-auto | --sandbox <mode>   no TTY approval prompts
	//   -m / --model                     per-command model override
	flags := []string{"exec", "--json"}
	if a.skipGitRepoCheck {
		flags = append(flags, "--skip-git-repo-check")
	}
	switch {
	case a.sandbox != "":
		flags = append(flags, "--sandbox", a.sandbox)
	case a.fullAuto:
		flags = append(flags, "--full-auto")
	}
	if model, ok := cmd.Options["model"].(string); ok && model != "" {
		flags = append(flags, "--model", model)
	}
	flags = append(flags, a.extraArgs...)

	var args []string
	if cmd.ExternalID != "" {
		args = append(flags, "resume", cmd.ExternalID, cmd.Prompt)
	} else {
		args = append(flags, cmd.Prompt)
	}

	// Per-run state so mapCodexLine can snapshot file contents at item.started
	// and emit a unified diff on item.completed.
	state := newFileEditState()

	spec := StreamSpec{
		Binary:     a.binary,
		Args:       args,
		Dir:        a.workingDir,
		StderrKind: protocol.KindStderr,
		Mapper: func(line string) []Chunk {
			return mapCodexLine(line, state)
		},
	}
	runner, err := Start(ctx, spec)
	if err != nil {
		return nil, err
	}
	a.runMu.Lock()
	a.runs[cmd.ID] = runner
	a.runMu.Unlock()
	out := make(chan Chunk, 32)
	go func() {
		defer close(out)
		for c := range runner.Chunks {
			if isCodexStderrNoise(c) {
				continue
			}
			out <- c
		}
		a.runMu.Lock()
		delete(a.runs, cmd.ID)
		a.runMu.Unlock()
	}()
	return out, nil
}

// codex prints a few cosmetic lines to stderr in --json mode that don't carry
// real signal. Filter them so the UI doesn't show a phantom red error block.
func isCodexStderrNoise(c Chunk) bool {
	if c.Kind != protocol.KindStderr {
		return false
	}
	t := strings.TrimSpace(c.Content)
	switch t {
	case "Reading additional input from stdin...",
		"Reading additional input from stdin…":
		return true
	}
	return false
}

func (a *CodexAdapter) Cancel(_ context.Context, commandID string) error {
	a.runMu.Lock()
	r := a.runs[commandID]
	a.runMu.Unlock()
	if r != nil {
		r.Cancel()
	}
	return nil
}

// CloneSession forks Codex's on-disk rollout for srcExternalID into a
// new rollout file under today's date directory. Codex stores each
// session at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl
// and embeds the session id only on line 1 (`session_meta.payload.id`),
// so the file body is otherwise verbatim-copyable. Turn boundaries are
// `event_msg` lines whose `payload.type == "task_started"` (each
// `codex resume` invocation emits a fresh one).
//
// turnIndex is 1-based; we stop emitting at the (turnIndex+1)th
// task_started event. line 1 (`session_meta`) is always kept and gets
// `payload.id` rewritten to the new UUID.
func (a *CodexAdapter) CloneSession(
	_ context.Context, srcExternalID string, turnIndex int,
) (string, error) {
	home, err := homeDir()
	if err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	sessionsRoot := filepath.Join(home, ".codex", "sessions")
	// Codex buckets by YYYY/MM/DD; we don't know the source's date
	// upfront so glob across all date dirs.
	srcFile, err := findFirstFile(sessionsRoot, filepath.Join("*", "*", "*", "rollout-*-"+srcExternalID+".jsonl"))
	if err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	if srcFile == "" {
		return "", fmtCloneError("codex", srcExternalID, errCloneSrcNotFound)
	}

	newID := newSessionUUID()
	now := time.Now().UTC()
	dstDir := filepath.Join(sessionsRoot, fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", int(now.Month())), fmt.Sprintf("%02d", now.Day()))
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}
	// Codex's filename timestamp is ISO with `:` replaced by `-`.
	ts := now.Format("2006-01-02T15-04-05")
	dstFile := filepath.Join(dstDir, fmt.Sprintf("rollout-%s-%s.jsonl", ts, newID))
	out, err := os.OpenFile(dstFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", fmtCloneError("codex", srcExternalID, err)
	}

	taskStartedSeen := 0
	stopped := false
	lineNum := 0
	werr := readJSONLines(srcFile, func(raw []byte, parsed map[string]any) error {
		if stopped {
			return nil
		}
		lineNum++
		if parsed == nil {
			// Unparseable line — copy verbatim if we're not yet past the
			// header but otherwise drop. The header lines are always JSON
			// in observed files, so this branch only catches drift.
			return writeJSONLine(out, raw)
		}
		recType, _ := parsed["type"].(string)
		// Line 1 should be session_meta; rewrite payload.id either way
		// in case Codex ever moves the meta record.
		if recType == "session_meta" {
			if pl, ok := parsed["payload"].(map[string]any); ok {
				pl["id"] = newID
			}
			b, err := json.Marshal(parsed)
			if err != nil {
				return err
			}
			return writeJSONLine(out, b)
		}
		if recType == "event_msg" {
			if pl, ok := parsed["payload"].(map[string]any); ok {
				if t, _ := pl["type"].(string); t == "task_started" {
					if taskStartedSeen >= turnIndex {
						stopped = true
						return nil
					}
					taskStartedSeen++
				}
			}
		}
		return writeJSONLine(out, raw)
	})
	if cerr := out.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(dstFile)
		return "", fmtCloneError("codex", srcExternalID, werr)
	}
	return newID, nil
}

// mapCodexLine handles the codex 0.121+ NDJSON schema:
//
//	{type: "thread.started", thread_id: "..."}
//	{type: "turn.started"}
//	{type: "item.started"|"item.completed", item: {type, ...}}
//	{type: "turn.completed", usage: {...}}
//	{type: "error", message: "..."}
//
// We also keep the older `session_configured` / `agent_message_delta` /
// `task_complete` shapes as a fallback for older codex builds.
func mapCodexLine(line string, state *fileEditState) []Chunk {
	ev := TryParseJSON(line)
	if ev == nil {
		return []Chunk{{Kind: protocol.KindDelta, Delta: line}}
	}
	inner := ev
	if m, ok := ev["msg"].(map[string]any); ok {
		inner = m
	}
	t, _ := inner["type"].(string)

	switch t {
	// ── 0.121+ thread/turn lifecycle ────────────────────────────────────
	case "thread.started":
		sid := firstString(inner, "thread_id", "id", "session_id", "conversation_id")
		return []Chunk{{
			Kind:       protocol.KindProgress,
			Content:    "thread started",
			Meta:       ev,
			ExternalID: sid,
		}}
	case "turn.started":
		return nil
	case "turn.completed":
		return []Chunk{{Kind: protocol.KindFinal, Meta: ev, IsFinal: true}}

	// ── 0.121+ item.* events ────────────────────────────────────────────
	case "item.started", "item.completed":
		item := toMap(inner["item"])
		if item == nil {
			return nil
		}
		return mapCodexItem(t, item, ev, state)

	// ── legacy event names (older codex builds) ─────────────────────────
	case "session_configured":
		sid := firstString(inner, "session_id", "id", "conversation_id")
		return []Chunk{{
			Kind:       protocol.KindProgress,
			Content:    "session configured",
			Meta:       ev,
			ExternalID: sid,
		}}
	case "agent_message_delta", "delta":
		d := firstString(inner, "delta", "text", "content")
		if d == "" {
			return nil
		}
		return []Chunk{{Kind: protocol.KindDelta, Delta: d}}
	case "agent_message":
		txt := firstString(inner, "message", "text", "content")
		if txt == "" {
			return []Chunk{{Kind: protocol.KindProgress, Meta: ev}}
		}
		return []Chunk{{Kind: protocol.KindDelta, Delta: txt}}
	case "tool_call", "exec_command_begin", "tool_use":
		name := firstString(inner, "name", "tool", "command")
		args := toMap(inner["arguments"])
		if args == nil {
			args = toMap(inner["input"])
		}
		return []Chunk{{
			Kind:    protocol.KindTool,
			Content: fmt.Sprintf("%s %s", name, FormatToolArgs(args)),
			Meta:    ev,
		}}
	case "exec_command_output", "tool_result":
		return []Chunk{{
			Kind:    protocol.KindStdout,
			Content: firstString(inner, "output", "stdout", "content"),
			Meta:    ev,
		}}
	case "task_complete", "turn_complete":
		return []Chunk{{Kind: protocol.KindFinal, Meta: ev, IsFinal: true}}
	case "error":
		return []Chunk{{
			Kind:    protocol.KindError,
			Content: firstString(inner, "message", "error"),
			Meta:    ev,
			IsFinal: true,
		}}
	}
	return nil // drop unknown events instead of emitting empty progress
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
				if diff, _, ok := state.BuildDiff(chunkID, kind); ok {
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
