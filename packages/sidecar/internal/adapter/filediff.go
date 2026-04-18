package adapter

import (
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/pmezard/go-difflib/difflib"
)

// This file holds the per-Execute file-edit diff machinery shared by every
// adapter. The flow is identical regardless of CLI:
//
//  1. When the agent says "I'm about to write/edit/delete <path>", call
//     fileEditState.RememberBefore(id, path). We read the file (if it
//     exists) and stash the bytes keyed by the tool-call id.
//  2. When the matching result event arrives, call BuildDiff(id, path, kind)
//     to produce a unified diff string between the snapshot and the now-
//     current file. The caller emits that string as the result chunk's
//     content with `meta.isDiff = true`, which the web UI (`DiffBlock`
//     in `ToolPill.tsx`) renders with per-line colors.
//
// The snapshot lives only for the duration of one Execute(), so adapters
// MUST construct a fresh state per run; we never share across commands.

// Caps on what we'll read or diff. Keeps payloads sane on Redis and the UI.
const (
	maxDiffFileBytes = 256 * 1024 // 256 KiB
	maxDiffLines     = 400
)

type fileSnapshot struct {
	content string
	exists  bool
}

type fileEditEntry struct {
	snap fileSnapshot
	path string
}

type fileEditState struct {
	mu      sync.Mutex
	entries map[string]fileEditEntry
}

func newFileEditState() *fileEditState {
	return &fileEditState{entries: map[string]fileEditEntry{}}
}

// RememberBefore reads the file at `path` (if any) and stores both the
// snapshot and the path under `id`. Snapshots that fail safety checks
// (binary, too big) are *not* stored, which causes the matching
// BuildDiff() call to fall back to plain "<verb> <path>" text.
// id="" or path="" no-ops.
func (s *fileEditState) RememberBefore(id, path string) {
	if s == nil || id == "" || path == "" {
		return
	}
	snap, err := readFileSafe(path)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.entries[id] = fileEditEntry{snap: snap, path: path}
	s.mu.Unlock()
}

// BuildDiff returns (diff, resolvedPath, ok). It looks up the snapshot
// stored by RememberBefore(id), re-reads the file, and produces a unified
// diff. If kind says "delete" we treat the after-state as empty rather than
// re-reading. `kind` is one of "add" | "update" | "delete" | "rename" | ""
// (empty treated as update).
//
// We always read the post-change file ourselves rather than trusting the
// CLI's reported new content — that lets a single code path serve every
// adapter regardless of how the tool reports its result.
func (s *fileEditState) BuildDiff(id, kind string) (string, string, bool) {
	if s == nil || id == "" {
		return "", "", false
	}
	s.mu.Lock()
	entry, haveBefore := s.entries[id]
	if haveBefore {
		delete(s.entries, id)
	}
	s.mu.Unlock()
	if !haveBefore {
		return "", "", false
	}

	k := strings.ToLower(kind)
	if k == "rename" || k == "move" || k == "moved" {
		// Single-path entries can't represent a rename meaningfully.
		return "", entry.path, false
	}

	before := ""
	if entry.snap.exists {
		before = entry.snap.content
	}

	after := ""
	if k != "delete" && k != "deleted" && k != "remove" {
		afterSnap, afterErr := readFileSafe(entry.path)
		if afterErr != nil || !afterSnap.exists {
			return "", entry.path, false
		}
		after = afterSnap.content
	}

	if before == after {
		return "", entry.path, false
	}

	diff := unifiedDiff(before, after, "a/"+entry.path, "b/"+entry.path)
	if diff == "" {
		return "", entry.path, false
	}
	return truncateDiff(diff, maxDiffLines), entry.path, true
}

// readFileSafe reads a file while refusing anything too large or obviously
// binary. exists=false means the file isn't there (a normal case for "add"
// snapshots); a non-nil error means "we found a file but won't diff it"
// (binary, directory, oversized) — callers should treat that as "don't even
// remember this snapshot" so the result falls back to plain text.
func readFileSafe(path string) (fileSnapshot, error) {
	if path == "" {
		return fileSnapshot{}, nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return fileSnapshot{exists: false}, nil
	}
	if info.IsDir() {
		return fileSnapshot{exists: true}, fmt.Errorf("skip dir")
	}
	if info.Size() > maxDiffFileBytes {
		return fileSnapshot{exists: true}, fmt.Errorf("skip oversize")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fileSnapshot{exists: false}, nil
	}
	if !looksTextual(data) {
		return fileSnapshot{exists: true}, fmt.Errorf("binary")
	}
	return fileSnapshot{exists: true, content: string(data)}, nil
}

// looksTextual is a cheap heuristic: a NUL byte in the first ~8 KiB strongly
// implies binary. Good enough to keep us from dumping executables into Redis.
func looksTextual(b []byte) bool {
	n := len(b)
	if n > 8192 {
		n = 8192
	}
	for i := 0; i < n; i++ {
		if b[i] == 0 {
			return false
		}
	}
	return true
}

func unifiedDiff(a, b, aName, bName string) string {
	ud := difflib.UnifiedDiff{
		A:        difflib.SplitLines(a),
		B:        difflib.SplitLines(b),
		FromFile: aName,
		ToFile:   bName,
		Context:  3,
	}
	out, err := difflib.GetUnifiedDiffString(ud)
	if err != nil {
		return ""
	}
	return out
}

func truncateDiff(s string, maxLines int) string {
	lines := strings.Split(s, "\n")
	if len(lines) <= maxLines {
		return s
	}
	cut := lines[:maxLines]
	more := len(lines) - maxLines
	cut = append(cut, fmt.Sprintf("… %d more lines truncated", more))
	return strings.Join(cut, "\n")
}

// resolveFilePath joins a possibly-relative path against the working dir so
// we read the same file the agent's tool would have written. Absolute paths
// pass through unchanged; empty strings stay empty.
func resolveFilePath(workingDir, path string) string {
	if path == "" {
		return ""
	}
	if strings.HasPrefix(path, "/") || strings.HasPrefix(path, "~") {
		return path
	}
	if workingDir == "" {
		return path
	}
	return strings.TrimRight(workingDir, "/") + "/" + path
}
