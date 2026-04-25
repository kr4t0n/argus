package adapter

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// Mapper turns a raw line (possibly JSON) from the CLI into a Chunk.
// If `line` is not JSON or the adapter cannot interpret it, it should return
// an adapter-specific default (usually a `delta` chunk).
type Mapper func(line string) []Chunk

// StreamSpec describes how to spawn and read a CLI subprocess.
type StreamSpec struct {
	// Binary is the absolute or PATH-resolvable name of the CLI.
	Binary string
	// Args is the command-line args. Use $PROMPT / $SESSION tokens where needed;
	// however we pass the prompt on stdin when PromptOnStdin is true.
	Args []string
	// Env adds/overrides environment variables.
	Env []string
	// Stdin to feed to the subprocess, if any.
	Stdin string
	// Working directory.
	Dir string
	// Mapper transforms lines (from stdout) into chunks.
	Mapper Mapper
	// StderrKind is the ResultKind for lines read from stderr (usually
	// `stderr` or `progress`). Empty means "don't emit stderr chunks".
	StderrKind protocol.ResultKind
}

// CLIRunner is returned by Start and exposes a cancel handle and the chunk stream.
type CLIRunner struct {
	Chunks <-chan Chunk
	cmd    *exec.Cmd
	mu     sync.Mutex
	done   bool
}

// Start spawns the subprocess and begins streaming chunks.
func Start(ctx context.Context, spec StreamSpec) (*CLIRunner, error) {
	if spec.Binary == "" {
		return nil, errors.New("binary is required")
	}
	if spec.Mapper == nil {
		spec.Mapper = func(line string) []Chunk {
			return []Chunk{{Kind: protocol.KindDelta, Delta: line + "\n"}}
		}
	}
	cmd := exec.CommandContext(ctx, spec.Binary, spec.Args...)
	if len(spec.Env) > 0 {
		cmd.Env = append(cmd.Environ(), spec.Env...)
	}
	if spec.Dir != "" {
		cmd.Dir = spec.Dir
	}
	// Only attach a stdin pipe if we actually have input to feed. CLIs like
	// `codex exec` sniff `!isatty(stdin)` and switch into "read piped prompt"
	// mode when a pipe is present, even if we close it immediately. Leaving
	// cmd.Stdin nil makes the child read from os.DevNull instead.
	var stdin io.WriteCloser
	if spec.Stdin != "" {
		var err error
		stdin, err = cmd.StdinPipe()
		if err != nil {
			return nil, err
		}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if stdin != nil {
		go func() {
			defer stdin.Close()
			_, _ = io.WriteString(stdin, spec.Stdin)
		}()
	}

	out := make(chan Chunk, 64)
	runner := &CLIRunner{Chunks: out, cmd: cmd}

	var wg sync.WaitGroup
	wg.Add(2)

	// stdout
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if strings.TrimSpace(line) == "" {
				continue
			}
			for _, c := range spec.Mapper(line) {
				select {
				case out <- c:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	// stderr
	go func() {
		defer wg.Done()
		if spec.StderrKind == "" {
			_, _ = io.Copy(io.Discard, stderr)
			return
		}
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 32*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			if strings.TrimSpace(line) == "" {
				continue
			}
			select {
			case out <- Chunk{Kind: spec.StderrKind, Content: line}:
			case <-ctx.Done():
				return
			}
		}
	}()

	// waiter: when both pipes close and process exits, emit final/error and close channel.
	go func() {
		wg.Wait()
		err := cmd.Wait()
		runner.mu.Lock()
		runner.done = true
		runner.mu.Unlock()
		if err != nil && !isCancelled(err, ctx) {
			out <- Chunk{Kind: protocol.KindError, Content: err.Error(), IsFinal: true}
		} else {
			out <- Chunk{Kind: protocol.KindFinal, IsFinal: true}
		}
		close(out)
	}()

	return runner, nil
}

// Cancel sends SIGTERM to the subprocess, then SIGKILL after a grace period.
func (r *CLIRunner) Cancel() {
	r.mu.Lock()
	if r.done || r.cmd == nil || r.cmd.Process == nil {
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()
	_ = r.cmd.Process.Signal(syscall.SIGTERM)
	go func() {
		time.Sleep(3 * time.Second)
		r.mu.Lock()
		defer r.mu.Unlock()
		if !r.done && r.cmd.Process != nil {
			_ = r.cmd.Process.Kill()
		}
	}()
}

func isCancelled(err error, ctx context.Context) bool {
	if ctx.Err() != nil {
		return true
	}
	if ee, ok := err.(*exec.ExitError); ok {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok {
			if ws.Signaled() && (ws.Signal() == syscall.SIGTERM || ws.Signal() == syscall.SIGKILL) {
				return true
			}
		}
	}
	return false
}

// TryParseJSON tries to decode a line as JSON; returns nil on failure.
func TryParseJSON(line string) map[string]any {
	var m map[string]any
	dec := json.NewDecoder(strings.NewReader(line))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return nil
	}
	return m
}

// FormatToolArgs renders a compact single-line representation of tool args.
func FormatToolArgs(args map[string]any) string {
	if len(args) == 0 {
		return ""
	}
	b := &strings.Builder{}
	first := true
	for k, v := range args {
		if !first {
			b.WriteString(" ")
		}
		first = false
		fmt.Fprintf(b, "%s=%v", k, v)
	}
	return b.String()
}
