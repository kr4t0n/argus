package adapter

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// CLI session storage layouts the cloners target. Discovered empirically
// by inspecting on-disk transcripts; documented in
// docs (or AGENTS.md follow-up) so future format shifts are caught fast.
//
//	~/.claude/projects/<slug>/<sessionId>.jsonl
//	~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl
//	~/.cursor/projects/<slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl
//
// The two slug encodings differ by ONE character: Claude keeps the
// leading `/` (encodes as a leading `-`), Cursor strips it. Both replace
// every other `/` with `-`. We expose helpers for each so the per-adapter
// cloners don't get this wrong.

// claudeProjectSlug encodes an absolute working directory the way Claude
// Code does on disk: every `/` becomes `-`, including the leading slash
// (so /home/kyle/foo becomes -home-kyle-foo).
func claudeProjectSlug(workingDir string) string {
	return strings.ReplaceAll(workingDir, "/", "-")
}

// cursorProjectSlug encodes the same path the way Cursor CLI stores it
// (no leading dash; a leading slash is stripped before slashes are
// replaced with dashes).
func cursorProjectSlug(workingDir string) string {
	return strings.ReplaceAll(strings.TrimPrefix(workingDir, "/"), "/", "-")
}

// homeDir returns $HOME, falling back to os.UserHomeDir.
func homeDir() (string, error) {
	if h := os.Getenv("HOME"); h != "" {
		return h, nil
	}
	return os.UserHomeDir()
}

// readJSONLines streams a JSONL file line by line, decoding each line as
// a generic map. The last line of a file written without a trailing
// newline is still returned. The line slice ([]byte) the callback gets
// is the *raw* bytes (not the decoded map's re-encoding) so callers that
// just want to copy lines verbatim avoid round-tripping through json.
func readJSONLines(path string, fn func(raw []byte, parsed map[string]any) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		stop := errors.Is(err, io.EOF)
		if err != nil && !stop {
			return err
		}
		trimmed := line
		// Strip the trailing newline for json.Unmarshal but keep the
		// original `line` (with newline) for raw verbatim writes.
		if n := len(trimmed); n > 0 && trimmed[n-1] == '\n' {
			trimmed = trimmed[:n-1]
		}
		if len(trimmed) == 0 {
			if stop {
				return nil
			}
			continue
		}
		var m map[string]any
		if jerr := json.Unmarshal(trimmed, &m); jerr != nil {
			// Skip undecodable lines but don't abort — adapters that
			// occasionally write non-JSON garbage shouldn't break the
			// fork. Caller decides what to do based on parsed==nil.
			if cerr := fn(line, nil); cerr != nil {
				return cerr
			}
		} else {
			if cerr := fn(line, m); cerr != nil {
				return cerr
			}
		}
		if stop {
			return nil
		}
	}
}

// writeJSONLineAtomic writes b followed by a newline (if missing) to w.
// Returns an error if the underlying write fails.
func writeJSONLine(w io.Writer, b []byte) error {
	if _, err := w.Write(b); err != nil {
		return err
	}
	if len(b) == 0 || b[len(b)-1] != '\n' {
		if _, err := w.Write([]byte{'\n'}); err != nil {
			return err
		}
	}
	return nil
}

// newSessionUUID returns a fresh CLI-compatible session id. We use UUID
// v4 — Codex's native ids are UUID7-ish, Claude's and Cursor's are v4,
// but all three CLIs treat the id as opaque so v4 is universally safe.
func newSessionUUID() string { return uuid.NewString() }

// findFirstFile returns the first file matching `pattern` (relative to
// `root`) using filepath.Glob. Returns ("", nil) when nothing matches.
func findFirstFile(root, pattern string) (string, error) {
	matches, err := filepath.Glob(filepath.Join(root, pattern))
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", nil
	}
	return matches[0], nil
}

// errCloneSrcNotFound is returned when the per-adapter cloner can't
// locate the source session file on disk. The supervisor surfaces this
// up to the server (eventually) so the dashboard can degrade to a
// history-only fork.
var errCloneSrcNotFound = errors.New("clone source session not found on disk")

// fmtCloneError wraps an error with the src external id so logs are
// scannable when multiple adapters' clones are interleaved.
func fmtCloneError(adapter, srcID string, err error) error {
	return fmt.Errorf("%s clone %s: %w", adapter, srcID, err)
}
