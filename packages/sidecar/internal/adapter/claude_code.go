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
	//   --model <name>                       per-command model override
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
	if model, ok := cmd.Options["model"].(string); ok && model != "" {
		args = append(args, "--model", model)
	}
	args = append(args, a.extraArgs...)

	// Per-run state so mapClaudeLine can snapshot file contents at tool_use
	// time and emit a unified diff at the matching tool_result. Scoped to
	// this Execute() so we never leak across runs.
	state := newFileEditState()

	spec := StreamSpec{
		Binary:     a.binary,
		Args:       args,
		Stdin:      cmd.Prompt,
		Dir:        a.workingDir,
		StderrKind: protocol.KindStderr,
		Mapper: func(line string) []Chunk {
			return mapClaudeLine(line, state, a.workingDir)
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
// turnIndex is 1-based; we stop emitting at the (turnIndex+1)th user
// turn boundary. A user line whose `message.content[].type` is
// `tool_result` is NOT a turn boundary — those are tool feedback paired
// with the previous assistant turn. Stopping there would leave a
// dangling tool_use without its result, which Claude refuses to resume.
func (a *ClaudeCodeAdapter) CloneSession(
	_ context.Context, srcExternalID string, turnIndex int,
) (string, error) {
	if a.workingDir == "" {
		return "", fmtCloneError("claude-code", srcExternalID,
			fmt.Errorf("workingDir not set; cannot derive project slug"))
	}
	home, err := homeDir()
	if err != nil {
		return "", fmtCloneError("claude-code", srcExternalID, err)
	}
	slug := claudeProjectSlug(a.workingDir)
	projectDir := filepath.Join(home, ".claude", "projects", slug)
	srcFile := filepath.Join(projectDir, srcExternalID+".jsonl")
	if _, err := os.Stat(srcFile); err != nil {
		if os.IsNotExist(err) {
			return "", fmtCloneError("claude-code", srcExternalID, errCloneSrcNotFound)
		}
		return "", fmtCloneError("claude-code", srcExternalID, err)
	}

	newID := newSessionUUID()
	dstFile := filepath.Join(projectDir, newID+".jsonl")
	out, err := os.OpenFile(dstFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", fmtCloneError("claude-code", srcExternalID, err)
	}

	userTextSeen := 0
	stopped := false
	werr := readJSONLines(srcFile, func(_ []byte, parsed map[string]any) error {
		if stopped {
			return nil
		}
		if parsed == nil {
			return nil
		}
		// User-text lines are turn boundaries; tool_result-only user
		// lines are NOT (they pair with the prior assistant tool_use).
		if t, _ := parsed["type"].(string); t == "user" && claudeIsUserTextTurn(parsed) {
			if userTextSeen >= turnIndex {
				stopped = true
				return nil
			}
			userTextSeen++
		}
		// Rewrite every line's sessionId in-place. We re-marshal the
		// whole map rather than substring-replacing because sessionId
		// can incidentally appear inside user prompt text and we don't
		// want to clobber that.
		parsed["sessionId"] = newID
		b, err := json.Marshal(parsed)
		if err != nil {
			return err
		}
		return writeJSONLine(out, b)
	})
	if cerr := out.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.Remove(dstFile)
		return "", fmtCloneError("claude-code", srcExternalID, werr)
	}
	return newID, nil
}

// claudeIsUserTextTurn reports whether a `type: "user"` line represents
// a fresh user prompt (turn boundary) vs. tool-result feedback to the
// previous assistant turn. Treats lines with mixed content (rare: a
// tool_result alongside text) as text turns to err on the safe side of
// "include this turn", since under-truncation is recoverable but
// over-truncation drops a real prompt.
func claudeIsUserTextTurn(line map[string]any) bool {
	msg, _ := line["message"].(map[string]any)
	contents, _ := msg["content"].([]any)
	if len(contents) == 0 {
		// User lines without structured content are treated as text
		// (older shape: `message.content` was a string).
		return true
	}
	for _, c := range contents {
		item, _ := c.(map[string]any)
		switch item["type"] {
		case "text", "input_text":
			return true
		case "tool_result":
			// keep walking; tool_result alone means feedback, not a turn
		default:
			// unknown content types: treat as text to avoid dropping
			// a real prompt.
			return true
		}
	}
	return false
}

// mapClaudeLine handles the Claude Code stream-json schema (also used by
// Cursor CLI, which intentionally mirrors it). The `state` and `workingDir`
// args let us snapshot file contents at tool_use time and emit a unified
// diff at the matching tool_result for file-modifying tools (Write/Edit/
// MultiEdit/Delete). Pass `state=nil` to disable diffing.
func mapClaudeLine(line string, state *fileEditState, workingDir string) []Chunk {
	ev := TryParseJSON(line)
	if ev == nil {
		return []Chunk{{Kind: protocol.KindDelta, Delta: line}}
	}
	t, _ := ev["type"].(string)
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
			// Counterpart to `task_started`: posted on completion (status
			// is in `status`, e.g. "completed") with a `summary` of what
			// the task did. Surface that as the pill content; status +
			// task_id + output_file ride along in Meta.
			if sum, _ := ev["summary"].(string); sum != "" {
				return []Chunk{{Kind: protocol.KindProgress, Content: sum, Meta: ev}}
			}
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
					out = append(out, Chunk{Kind: protocol.KindDelta, Delta: s})
				}
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

				out = append(out, Chunk{
					Kind:    protocol.KindTool,
					Content: fmt.Sprintf("%s %s", name, FormatToolArgs(input)),
					Meta:    map[string]any{"tool": name, "input": input, "id": toolID},
				})
			}
		}
		if len(out) == 0 {
			return []Chunk{{Kind: protocol.KindProgress, Meta: ev}}
		}
		return out

	case "user":
		msg, _ := ev["message"].(map[string]any)
		contents, _ := msg["content"].([]any)
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
