package adapter

import (
	"context"
	"fmt"
	"os/exec"
	"sync"

	"github.com/kyley/argus/sidecar/internal/protocol"
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

func init() {
	Register("cursor-cli", func(cfg map[string]any) (Adapter, error) {
		bin, _ := cfg["binary"].(string)
		if bin == "" {
			bin = "cursor-agent"
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
