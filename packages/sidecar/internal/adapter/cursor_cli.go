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
//	{ "type": "system",     "session_id": "..." }
//	{ "type": "assistant",  "message": { "content": [ {text}/{tool_use} ] } }
//	{ "type": "user",       "message": { "content": [ {tool_result} ] } }
//	{ "type": "result",     "result": "...", "is_error": bool }
type CursorCLIAdapter struct {
	binary     string
	workingDir string
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
		return &CursorCLIAdapter{
			binary:     bin,
			workingDir: WorkingDirFromCfg(cfg),
			runs:       map[string]*CLIRunner{},
		}, nil
	})
}

func (a *CursorCLIAdapter) Ping(ctx context.Context) error {
	return exec.CommandContext(ctx, a.binary, "--version").Run()
}

func (a *CursorCLIAdapter) Execute(
	ctx context.Context, cmd protocol.Command,
) (<-chan Chunk, error) {
	args := []string{"-p", "--output-format", "stream-json", "--force"}
	if cmd.ExternalID != "" {
		args = append(args, "--resume", cmd.ExternalID)
	}
	if model, ok := cmd.Options["model"].(string); ok && model != "" {
		args = append(args, "-m", model)
	}
	args = append(args, cmd.Prompt)

	// Per-run state so the mapper can snapshot file contents at tool_use
	// time and emit a unified diff at the matching tool_result. Same flow
	// and helpers as Claude Code; cursor-agent intentionally mirrors
	// Claude's stream-json schema.
	state := newFileEditState()

	spec := StreamSpec{
		Binary:     a.binary,
		Args:       args,
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
