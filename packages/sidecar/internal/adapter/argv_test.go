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

func TestCodexTurnStartInputs(t *testing.T) {
	a := &CodexAdapter{fullAuto: true}
	params := a.turnStartParams("thread-123", protocol.Command{
		ID: "cmd-1", Prompt: "--help",
		Attachments: []protocol.AttachmentRef{
			{Mime: "image/png", LocalPath: "/tmp/screenshot.png"},
			{Mime: "text/plain", LocalPath: "/tmp/notes.txt"},
		},
	})
	inputs, ok := params["input"].([]any)
	if !ok || len(inputs) != 2 {
		t.Fatalf("input = %#v, want text plus one local image", params["input"])
	}
	text, ok := inputs[0].(map[string]any)
	if !ok || text["type"] != "text" || text["text"] != "--help" {
		t.Fatalf("input[0] = %#v, want literal text prompt", inputs[0])
	}
	image, ok := inputs[1].(map[string]any)
	if !ok || image["type"] != "localImage" || image["path"] != "/tmp/screenshot.png" {
		t.Fatalf("input[1] = %#v, want local image", inputs[1])
	}
	resume := a.threadResumeParams("thread-123", protocol.Command{})
	if _, exists := resume["serviceName"]; exists {
		t.Fatalf("thread/resume must not include thread/start-only serviceName: %#v", resume)
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

// TestModelSelectionTransport covers ModelSelection mapping for all three
// adapters: argv for Claude/Cursor and turn/start fields for Codex app-server.
func TestModelSelectionTransport(t *testing.T) {
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
		a := &CodexAdapter{
			fullAuto: true,
		}
		params := a.turnStartParams("thread-1", protocol.Command{
			ID:     "cmd-1",
			Prompt: "hi",
			Options: map[string]any{
				"model":  "gpt-5.5",
				"effort": "high",
				"speed":  "fast",
			},
		})
		if params["model"] != "gpt-5.5" || params["effort"] != "high" || params["serviceTier"] != "fast" {
			t.Fatalf("model selection params = %#v", params)
		}
		if params["approvalPolicy"] != "never" {
			t.Fatalf("approvalPolicy = %#v, want never", params["approvalPolicy"])
		}
		wantSandbox := map[string]any{"type": "dangerFullAccess"}
		if !reflect.DeepEqual(params["sandboxPolicy"], wantSandbox) {
			t.Fatalf("sandboxPolicy = %#v, want %#v", params["sandboxPolicy"], wantSandbox)
		}
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
