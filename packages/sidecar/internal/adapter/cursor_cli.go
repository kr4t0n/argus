package adapter

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// CursorCLIAdapter wraps the Cursor agent CLI (`cursor-agent`) using
// --output-format stream-json. Events shape:
//
//	{ "type": "system",    "subtype": "init", "session_id": "..." }
//	{ "type": "assistant", "message": { "content": [ {text} ] } }
//	{ "type": "user",      "message": { "content": [ {text} ] } }   (our prompt)
//	{ "type": "tool_call", "subtype": "started"|"completed",
//	    "call_id": "...",
//	    "tool_call": { "<kind>ToolCall": { "args": {…}, "result": {…}? } } }
//	{ "type": "result",    "subtype": "success"|"error", "result": "..." }
//
// Defaults that differ from interactive `cursor-agent`:
//   - --force: non-interactive, skip confirmation screens.
//   - --yolo:  accept every tool call without prompting. Required for
//     headless operation since the sidecar has no TTY to approve through.
//
// `yolo` can be turned off from the sidecar YAML (approval prompts will
// then block the turn forever — useful only for manual debugging), and
// `extraArgs` lets you append arbitrary flags to every invocation.
type CursorCLIAdapter struct {
	binary     string
	workingDir string
	yolo       bool
	extraArgs  []string
	runMu      sync.Mutex
	runs       map[string]*CLIRunner
}

const cursorDefaultBinary = "cursor-agent"

func init() {
	Register("cursor-cli", Plugin{
		DefaultBinary: cursorDefaultBinary,
		Factory: func(cfg map[string]any) (Adapter, error) {
			bin, _ := cfg["binary"].(string)
			if bin == "" {
				bin = cursorDefaultBinary
			}
			if _, err := exec.LookPath(bin); err != nil {
				return nil, fmt.Errorf("cursor-agent CLI %q not found: %w", bin, err)
			}
			a := &CursorCLIAdapter{
				binary:     bin,
				workingDir: WorkingDirFromCfg(cfg),
				yolo:       boolFromCfg(cfg, "yolo", true),
				runs:       map[string]*CLIRunner{},
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

func (a *CursorCLIAdapter) Ping(ctx context.Context) error {
	return exec.CommandContext(ctx, a.binary, "--version").Run()
}

func (a *CursorCLIAdapter) Version(ctx context.Context) (string, error) {
	return readBinaryVersion(ctx, a.binary)
}

func (a *CursorCLIAdapter) Execute(
	ctx context.Context, cmd protocol.Command,
) (<-chan Chunk, error) {
	// Flag layout (cursor-agent [...flags...] <prompt>):
	//   -p / --print                  non-interactive: print & exit
	//   --output-format stream-json   NDJSON stream on stdout
	//   --force                       skip confirmation screens
	//   --yolo                        accept every tool call w/o prompting
	//   --resume <id>                 resume prior session
	//   -m / --model <name>           per-command model override
	args := []string{"-p", "--output-format", "stream-json", "--force"}
	if a.yolo {
		args = append(args, "--yolo")
	}
	if cmd.ExternalID != "" {
		args = append(args, "--resume", cmd.ExternalID)
	}
	if model, ok := cmd.Options["model"].(string); ok && model != "" {
		args = append(args, "-m", model)
	}
	args = append(args, a.extraArgs...)
	args = append(args, cmd.Prompt)

	// cursor-agent's stream-json schema diverged from Claude's: it emits
	// top-level `tool_call` events with a typed `*ToolCall` payload (and
	// already includes a unified `diffString` for edit-style tools), so
	// it gets its own mapper. We thread a fileEditState in for forward
	// compat — the current schema doesn't need it, but a future cursor
	// release that omits diffString could opt back into snapshot diffing.
	state := newFileEditState()

	spec := StreamSpec{
		Binary:     a.binary,
		Args:       args,
		Dir:        a.workingDir,
		StderrKind: protocol.KindStderr,
		Mapper: func(line string) []Chunk {
			return mapCursorLine(line, state, a.workingDir)
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
			out <- c
		}
		a.runMu.Lock()
		delete(a.runs, cmd.ID)
		a.runMu.Unlock()
	}()
	return out, nil
}

func (a *CursorCLIAdapter) Cancel(_ context.Context, commandID string) error {
	a.runMu.Lock()
	r := a.runs[commandID]
	a.runMu.Unlock()
	if r != nil {
		r.Cancel()
	}
	return nil
}

// CloneSession forks the Cursor CLI's on-disk transcript for srcExternalID
// into a new chat directory. Cursor stores each chat under
// ~/.cursor/projects/<slug>/agent-transcripts/<chat-id>/<chat-id>.jsonl,
// where each JSONL line is one message ({role, message}). The chat id
// is encoded only in the filenames — never inside the line content —
// so cloning is a pure filesystem operation: create the new directory,
// copy lines until we hit the (turnIndex+1)th `role: "user"` line, stop.
//
// Returns the new chat id; errors leave nothing behind on disk.
func (a *CursorCLIAdapter) CloneSession(
	_ context.Context, srcExternalID string, turnIndex int,
) (string, error) {
	if a.workingDir == "" {
		return "", fmtCloneError("cursor-cli", srcExternalID,
			fmt.Errorf("workingDir not set; cannot derive project slug"))
	}
	home, err := homeDir()
	if err != nil {
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}
	slug := cursorProjectSlug(a.workingDir)
	srcDir := filepath.Join(home, ".cursor", "projects", slug, "agent-transcripts", srcExternalID)
	srcFile := filepath.Join(srcDir, srcExternalID+".jsonl")
	if _, err := os.Stat(srcFile); err != nil {
		if os.IsNotExist(err) {
			return "", fmtCloneError("cursor-cli", srcExternalID, errCloneSrcNotFound)
		}
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}

	newID := newSessionUUID()
	dstDir := filepath.Join(home, ".cursor", "projects", slug, "agent-transcripts", newID)
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}
	dstFile := filepath.Join(dstDir, newID+".jsonl")
	out, err := os.OpenFile(dstFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		_ = os.RemoveAll(dstDir)
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}

	// turnIndex is 1-based: keep the first N user turns plus their
	// assistant responses. The (N+1)th `role: "user"` line is where we
	// stop — that's the prompt that would have started turn N+1.
	userSeen := 0
	stopped := false
	werr := readJSONLines(srcFile, func(raw []byte, parsed map[string]any) error {
		if stopped {
			return nil
		}
		if parsed != nil {
			if role, _ := parsed["role"].(string); role == "user" {
				if userSeen >= turnIndex {
					stopped = true
					return nil
				}
				userSeen++
			}
		}
		return writeJSONLine(out, raw)
	})
	if cerr := out.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		_ = os.RemoveAll(dstDir)
		return "", fmtCloneError("cursor-cli", srcExternalID, werr)
	}
	return newID, nil
}
