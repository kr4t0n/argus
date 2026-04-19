package adapter

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"

	"github.com/kyley/argus/sidecar/internal/protocol"
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
		// first system event carries session_id
		if sub, _ := ev["subtype"].(string); sub == "init" {
			sid, _ := ev["session_id"].(string)
			if sid != "" {
				return []Chunk{{
					Kind:       protocol.KindProgress,
					Content:    "session initialised",
					Meta:       ev,
					ExternalID: sid,
				}}
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
