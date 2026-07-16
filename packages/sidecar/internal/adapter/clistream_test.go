package adapter

import (
	"context"
	"testing"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// drainChunks collects every chunk until the runner closes the channel,
// failing the test if that takes suspiciously long (a hung waiter).
func drainChunks(t *testing.T, r *CLIRunner) []Chunk {
	t.Helper()
	var got []Chunk
	timeout := time.After(10 * time.Second)
	for {
		select {
		case c, ok := <-r.Chunks:
			if !ok {
				return got
			}
			got = append(got, c)
		case <-timeout:
			t.Fatalf("chunk channel never closed; got so far: %+v", got)
		}
	}
}

func terminalChunks(chunks []Chunk) []Chunk {
	var term []Chunk
	for _, c := range chunks {
		if c.IsFinal || c.Kind == protocol.KindFinal || c.Kind == protocol.KindError {
			term = append(term, c)
		}
	}
	return term
}

// resultMapper mimics a real adapter: the CLI's RESULT line becomes the
// turn's terminal chunk, everything else streams as deltas.
func resultMapper(line string) []Chunk {
	if line == "RESULT" {
		return []Chunk{{Kind: protocol.KindFinal, Content: "done", IsFinal: true}}
	}
	return []Chunk{{Kind: protocol.KindDelta, Delta: line}}
}

// TestRunCLISingleTerminalChunk verifies the waiter does NOT stack its
// synthetic process-exit final on top of the mapper's result final: the
// server finalizes a turn per terminal chunk, so a healthy turn must
// produce exactly one — the mapper's rich one (this was the cause of
// doubled push notifications).
func TestRunCLISingleTerminalChunk(t *testing.T) {
	r, err := Start(context.Background(), StreamSpec{
		Binary: "sh",
		Args:   []string{"-c", "echo hello; echo RESULT"},
		Mapper: resultMapper,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	term := terminalChunks(drainChunks(t, r))
	if len(term) != 1 {
		t.Fatalf("want exactly 1 terminal chunk, got %d: %+v", len(term), term)
	}
	if term[0].Content != "done" {
		t.Fatalf("the mapper's rich final must win, got %+v", term[0])
	}
}

// TestRunCLICrashSafetyNet verifies the synthetic terminal chunk still
// covers the case it exists for: the CLI dying without ever emitting its
// result event must land a KindError final so the turn doesn't hang in
// "running" forever.
func TestRunCLICrashSafetyNet(t *testing.T) {
	r, err := Start(context.Background(), StreamSpec{
		Binary: "sh",
		Args:   []string{"-c", "echo hello; exit 3"},
		Mapper: resultMapper,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	term := terminalChunks(drainChunks(t, r))
	if len(term) != 1 {
		t.Fatalf("want exactly 1 terminal chunk, got %d: %+v", len(term), term)
	}
	if term[0].Kind != protocol.KindError {
		t.Fatalf("want synthetic KindError final, got %+v", term[0])
	}
}

// TestRunCLICleanExitWithoutResult: a CLI that exits 0 without a result
// event still gets the synthetic final (a turn must always terminate).
func TestRunCLICleanExitWithoutResult(t *testing.T) {
	r, err := Start(context.Background(), StreamSpec{
		Binary: "sh",
		Args:   []string{"-c", "echo hello"},
		Mapper: resultMapper,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	term := terminalChunks(drainChunks(t, r))
	if len(term) != 1 {
		t.Fatalf("want exactly 1 terminal chunk, got %d: %+v", len(term), term)
	}
	if term[0].Kind != protocol.KindFinal {
		t.Fatalf("want synthetic KindFinal, got %+v", term[0])
	}
}
