package adapter

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

func TestCodexPromptStartingWithDashUsesEndOfOptions(t *testing.T) {
	tests := []struct {
		name       string
		externalID string
		wantTail   []string
	}{
		{
			name:     "fresh session",
			wantTail: []string{"--", "--help"},
		},
		{
			name:       "resume session",
			externalID: "thread-123",
			wantTail:   []string{"resume", "thread-123", "--", "--help"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			binary, argvFile := writeFakeCLI(t, `printf '%s\n' '{"type":"turn.completed"}'`)
			a := &CodexAdapter{
				binary:           binary,
				skipGitRepoCheck: true,
				fullAuto:         true,
				runs:             map[string]*CLIRunner{},
			}

			drainExecute(t, a, protocol.Command{
				ID:         "cmd-1",
				ExternalID: tt.externalID,
				Prompt:     "--help",
			})

			got := readArgv(t, argvFile)
			assertArgvTail(t, got, tt.wantTail)
		})
	}
}

func TestCursorPromptStartingWithDashUsesEndOfOptions(t *testing.T) {
	binary, argvFile := writeFakeCLI(t, `printf '%s\n' '{"type":"result","subtype":"success","result":"ok"}'`)
	a := &CursorCLIAdapter{
		binary: binary,
		yolo:   true,
		runs:   map[string]*CLIRunner{},
	}

	drainExecute(t, a, protocol.Command{
		ID:         "cmd-1",
		ExternalID: "cursor-session-1",
		Prompt:     "--help",
	})

	got := readArgv(t, argvFile)
	assertArgvTail(t, got, []string{"--resume", "cursor-session-1", "--", "--help"})
}

// TestModelSelectionArgv covers the ModelSelection → argv mapping for
// all three adapters: model/effort/context/speed ride Command.Options
// as flat keys and each adapter appends only the flags its CLI knows.
func TestModelSelectionArgv(t *testing.T) {
	t.Run("claude model+effort+1m", func(t *testing.T) {
		binary, argvFile := writeFakeCLI(t, `printf '%s\n' '{"type":"result","result":"ok","is_error":false}'`)
		a := &ClaudeCodeAdapter{
			binary:                     binary,
			dangerouslySkipPermissions: true,
			runners:                    map[string]*CLIRunner{},
		}
		drainExecute(t, a, protocol.Command{
			ID:     "cmd-1",
			Prompt: "hi",
			Options: map[string]any{
				"model":   "opus",
				"effort":  "xhigh",
				"context": "1m",
			},
		})
		got := readArgv(t, argvFile)
		assertArgvContains(t, got, []string{"--model", "opus[1m]"})
		assertArgvContains(t, got, []string{"--effort", "xhigh"})
	})

	t.Run("claude no double 1m suffix", func(t *testing.T) {
		binary, argvFile := writeFakeCLI(t, `printf '%s\n' '{"type":"result","result":"ok","is_error":false}'`)
		a := &ClaudeCodeAdapter{
			binary:                     binary,
			dangerouslySkipPermissions: true,
			runners:                    map[string]*CLIRunner{},
		}
		drainExecute(t, a, protocol.Command{
			ID:     "cmd-1",
			Prompt: "hi",
			Options: map[string]any{
				"model":   "claude-opus-4-8[1m]",
				"context": "1m",
			},
		})
		got := readArgv(t, argvFile)
		assertArgvContains(t, got, []string{"--model", "claude-opus-4-8[1m]"})
	})

	t.Run("codex model+effort+fast", func(t *testing.T) {
		binary, argvFile := writeFakeCLI(t, `printf '%s\n' '{"type":"turn.completed"}'`)
		a := &CodexAdapter{
			binary:           binary,
			skipGitRepoCheck: true,
			fullAuto:         true,
			runs:             map[string]*CLIRunner{},
		}
		drainExecute(t, a, protocol.Command{
			ID:     "cmd-1",
			Prompt: "hi",
			Options: map[string]any{
				"model":  "gpt-5.5",
				"effort": "high",
				"speed":  "fast",
			},
		})
		got := readArgv(t, argvFile)
		assertArgvContains(t, got, []string{"--model", "gpt-5.5"})
		assertArgvContains(t, got, []string{"-c", "model_reasoning_effort=high"})
		assertArgvContains(t, got, []string{"-c", "service_tier=fast"})
	})

	t.Run("cursor slug only", func(t *testing.T) {
		binary, argvFile := writeFakeCLI(t, `printf '%s\n' '{"type":"result","subtype":"success","result":"ok"}'`)
		a := &CursorCLIAdapter{
			binary: binary,
			yolo:   true,
			runs:   map[string]*CLIRunner{},
		}
		drainExecute(t, a, protocol.Command{
			ID:     "cmd-1",
			Prompt: "hi",
			Options: map[string]any{
				"model": "claude-opus-4-8-thinking-xhigh",
				// effort/speed must be ignored — the slug carries them.
				"effort": "high",
				"speed":  "fast",
			},
		})
		got := readArgv(t, argvFile)
		assertArgvContains(t, got, []string{"--model", "claude-opus-4-8-thinking-xhigh"})
		for _, arg := range got {
			if arg == "-c" || strings.HasPrefix(arg, "--effort") {
				t.Fatalf("cursor argv must not carry effort/speed flags, got %v", got)
			}
		}
	})
}

func writeFakeCLI(t *testing.T, stdoutScript string) (string, string) {
	t.Helper()

	dir := t.TempDir()
	argvFile := filepath.Join(dir, "argv")
	binary := filepath.Join(dir, "fake-cli")
	script := strings.Join([]string{
		"#!/bin/sh",
		": > \"$ARGUS_TEST_ARGV_FILE\"",
		"for arg in \"$@\"; do",
		"  printf '%s\\n' \"$arg\" >> \"$ARGUS_TEST_ARGV_FILE\"",
		"done",
		stdoutScript,
		"",
	}, "\n")
	if err := os.WriteFile(binary, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake CLI: %v", err)
	}
	t.Setenv("ARGUS_TEST_ARGV_FILE", argvFile)
	return binary, argvFile
}

func drainExecute(t *testing.T, a Adapter, cmd protocol.Command) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	chunks, err := a.Execute(ctx, cmd)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	for range chunks {
	}
}

func readArgv(t *testing.T, path string) []string {
	t.Helper()

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read argv file: %v", err)
	}
	raw := strings.TrimSuffix(string(b), "\n")
	if raw == "" {
		return nil
	}
	return strings.Split(raw, "\n")
}

// assertArgvContains asserts `want` appears as a contiguous
// subsequence anywhere in `got`.
func assertArgvContains(t *testing.T, got, want []string) {
	t.Helper()

	for i := 0; i+len(want) <= len(got); i++ {
		if reflect.DeepEqual(got[i:i+len(want)], want) {
			return
		}
	}
	t.Fatalf("argv missing subsequence:\nwant: %v\n got: %v", want, got)
}

func assertArgvTail(t *testing.T, got, wantTail []string) {
	t.Helper()

	if len(got) < len(wantTail) {
		t.Fatalf("argv too short: got %v, want tail %v", got, wantTail)
	}
	tail := got[len(got)-len(wantTail):]
	if !reflect.DeepEqual(tail, wantTail) {
		t.Fatalf("argv tail mismatch:\n got: %v\nwant: %v\nfull argv: %v", tail, wantTail, got)
	}
}
