// Package machine — filesystem browsing helpers.
//
// The dashboard's right-pane file tree talks to this via the machine
// control plane: the daemon receives an `fs-list` request, dispatches
// it here with the target agent's workingDir as the jail root, and
// publishes the response (or error) back on the shared lifecycle
// stream. We deliberately keep this file self-contained — no bus or
// protocol imports — so it's easy to unit-test against a temp dir.
package machine

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	gitignore "github.com/sabhiram/go-gitignore"
)

// FSEntry mirrors protocol.FSEntry but is declared here locally so the
// core of the fs code has no dependency on the wire layer. The daemon
// converts between the two at the publish boundary.
type FSEntry struct {
	Name       string
	Kind       string // "file" | "dir" | "symlink"
	Size       int64
	MTime      int64
	Gitignored bool
}

// ListDirRequest is the validated input ListDir expects.
type ListDirRequest struct {
	// WorkingDir is the absolute root the listing is jailed to. Any
	// resolved absolute path outside this root is rejected.
	WorkingDir string
	// Path is the client's request, relative to WorkingDir. Empty / "."
	// means the root.
	Path string
	// ShowAll disables gitignore filtering and shows dotfiles, but does
	// NOT expose `.git` itself — that directory is never useful in a
	// tree view and rendering it only adds noise.
	ShowAll bool
}

// resolvePath validates `rel` lives inside `root` and returns the
// absolute path to list. Rejects:
//   - absolute paths (clients always send relative)
//   - `..` escapes
//   - symlink chases out of the root
//
// We evaluate the path twice (raw join + symlink resolution) and jail
// both: the raw form catches the obvious escapes even if the symlink
// target doesn't exist yet, and the resolved form catches the subtle
// case of a symlink inside the root pointing outside.
func resolvePath(root, rel string) (string, error) {
	if filepath.IsAbs(rel) {
		return "", errors.New("absolute paths not allowed")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	rootAbs = filepath.Clean(rootAbs)

	target := rel
	if target == "" || target == "." {
		return rootAbs, nil
	}
	joined := filepath.Join(rootAbs, target)
	if !withinRoot(joined, rootAbs) {
		return "", errors.New("path escapes working directory")
	}
	// If the path exists, resolve symlinks and re-jail so a symlink
	// pointing outside the root can't be followed.
	if resolved, err := filepath.EvalSymlinks(joined); err == nil {
		if !withinRoot(resolved, resolveRoot(rootAbs)) {
			return "", errors.New("resolved path escapes working directory")
		}
		return resolved, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return joined, nil
}

func resolveRoot(rootAbs string) string {
	if resolved, err := filepath.EvalSymlinks(rootAbs); err == nil {
		return resolved
	}
	return rootAbs
}

func withinRoot(path, root string) bool {
	if path == root {
		return true
	}
	rootWithSep := root + string(filepath.Separator)
	return strings.HasPrefix(path, rootWithSep)
}

// ListDir reads one directory level. Applies gitignore filtering (and
// always drops `.git`) unless ShowAll is true. Sorts dirs first, then
// files, each alphabetical case-insensitive — the exact ordering the
// UI renders without needing client-side sort.
func ListDir(req ListDirRequest) ([]FSEntry, error) {
	if req.WorkingDir == "" {
		return nil, errors.New("agent has no working directory")
	}
	// We re-read .gitignore on every call rather than caching it on the
	// daemon. The listing itself dominates the cost (ReadDir + per-entry
	// stat), and rereading means edits surface immediately without us
	// needing an invalidation path.
	var matcher *gitignore.GitIgnore
	if !req.ShowAll {
		matcher, _ = loadGitignore(req.WorkingDir)
	}
	return listDirWith(req.WorkingDir, req.Path, req.ShowAll, matcher)
}

// listDirWith is the single-directory core shared by ListDir (which
// loads the gitignore matcher once per call) and ListDirs (which loads
// it once per BFS walk and reuses it across every level). Pass
// matcher=nil to disable gitignore filtering — callers do that when
// ShowAll is true.
func listDirWith(workingDir, relPath string, showAll bool, matcher *gitignore.GitIgnore) ([]FSEntry, error) {
	abs, err := resolvePath(workingDir, relPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q is not a directory", relPath)
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}

	rootAbs, _ := filepath.Abs(workingDir)
	rootAbs = filepath.Clean(rootAbs)

	out := make([]FSEntry, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if name == ".git" {
			// Dropped unconditionally — see ShowAll doc.
			continue
		}

		abspath := filepath.Join(abs, name)
		relpath, _ := filepath.Rel(rootAbs, abspath)
		isDir := e.IsDir()

		var ignored bool
		if matcher != nil {
			match := filepath.ToSlash(relpath)
			if isDir {
				// Dir-only gitignore patterns match with a trailing slash;
				// doing this here means we match both `build/` and `build`
				// forms correctly.
				match += "/"
			}
			ignored = matcher.MatchesPath(match)
		}
		if !showAll && ignored {
			continue
		}

		kind := "file"
		if e.Type()&os.ModeSymlink != 0 {
			kind = "symlink"
		} else if isDir {
			kind = "dir"
		}

		fi, ferr := e.Info()
		if ferr != nil {
			continue
		}
		out = append(out, FSEntry{
			Name:       name,
			Kind:       kind,
			Size:       fi.Size(),
			MTime:      fi.ModTime().UnixMilli(),
			Gitignored: ignored,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if (out[i].Kind == "dir") != (out[j].Kind == "dir") {
			return out[i].Kind == "dir"
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// ListDirs breadth-first walks up to `maxDepth` levels starting at
// req.Path and returns every directory's listing keyed by path
// (relative to WorkingDir; empty string = root). `maxDepth` counts the
// requested path as level 1, so maxDepth<=1 degenerates to a single
// ListDir call. Never descends into gitignored or symlinked
// subdirectories — both would blow up the walk (symlink loops, whole
// node_modules trees) for no user benefit.
//
// The walk stops enqueueing new children once totalCap entries have
// been collected. BFS means shallow levels are always filled first, so
// a truncated response is still useful: the tree root and every
// second-level folder the user is likely to click will be present
// even if a deep subtree is cut off.
//
// Errors on the root path are fatal. Errors on subdirectories are
// logged-and-skipped by returning no entries for that path — better to
// show a partial tree than refuse the whole prefetch over one
// permission-denied subdir.
func ListDirs(req ListDirRequest, maxDepth, totalCap int) (map[string][]FSEntry, error) {
	if req.WorkingDir == "" {
		return nil, errors.New("agent has no working directory")
	}
	if maxDepth < 1 {
		maxDepth = 1
	}
	if totalCap <= 0 {
		totalCap = 1 << 30 // effectively uncapped
	}

	var matcher *gitignore.GitIgnore
	if !req.ShowAll {
		matcher, _ = loadGitignore(req.WorkingDir)
	}

	rootPath := req.Path
	if rootPath == "." {
		rootPath = ""
	}

	type queueItem struct {
		path  string
		level int
	}
	listings := make(map[string][]FSEntry)
	queue := []queueItem{{path: rootPath, level: 1}}
	total := 0

	for len(queue) > 0 {
		item := queue[0]
		queue = queue[1:]

		entries, err := listDirWith(req.WorkingDir, item.path, req.ShowAll, matcher)
		if err != nil {
			if item.path == rootPath {
				return nil, err
			}
			// Subdirectory failure (permission, gone between walk and
			// listing): skip and continue. The client still gets every
			// sibling.
			continue
		}
		listings[item.path] = entries
		total += len(entries)

		if item.level >= maxDepth || total >= totalCap {
			continue
		}
		for _, e := range entries {
			if e.Kind != "dir" || e.Gitignored {
				continue
			}
			var childPath string
			if item.path == "" {
				childPath = e.Name
			} else {
				childPath = item.path + "/" + e.Name
			}
			queue = append(queue, queueItem{path: childPath, level: item.level + 1})
		}
	}
	return listings, nil
}

// ReadFileRequest is the validated input ReadFile expects. MaxBytes is
// the hard cap above which ReadFile returns Result="error" rather than
// truncating — partial highlight is misleading and large reads also
// blow out the JSON envelope on the lifecycle stream.
type ReadFileRequest struct {
	WorkingDir string
	Path       string
	MaxBytes   int64
}

// ReadFileResult is the wire-shaped reply, matching protocol.FSReadResponseEvent's
// Result discriminator. Only the fields relevant to the chosen variant
// are populated.
type ReadFileResult struct {
	Result  string // "text" | "image" | "binary" | "error"
	Content string // text only
	MIME    string // image only
	Base64  string // image only
	Size    int64
	Error   string
}

// imageMIMEByExt is an explicit allowlist of formats the dashboard
// renders inline. Anything else falls through to text/binary detection
// (an SVG, despite being text, is treated as an image so the user sees
// the rendered shape rather than markup).
var imageMIMEByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".avif": "image/avif",
}

// ReadFile loads one file for preview. Jails to WorkingDir, refuses
// directories, caps at MaxBytes, classifies into text / image / binary
// based on extension allowlist + a content sniff. The error variant is
// returned as a value (not an error) when the failure is a soft
// "can't preview" — over-cap or refused symlink — so the dashboard can
// render a meaningful placeholder rather than treating it as an RPC
// failure. Hard errors (path escape, missing file, read I/O) are
// surfaced as Go errors and the caller propagates them as result=error.
func ReadFile(req ReadFileRequest) (ReadFileResult, error) {
	if req.WorkingDir == "" {
		return ReadFileResult{}, errors.New("agent has no working directory")
	}
	abs, err := resolvePath(req.WorkingDir, req.Path)
	if err != nil {
		return ReadFileResult{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return ReadFileResult{}, err
	}
	if info.IsDir() {
		return ReadFileResult{}, fmt.Errorf("%q is a directory", req.Path)
	}
	if !info.Mode().IsRegular() {
		// Sockets, devices, fifos — refuse rather than block on read.
		return ReadFileResult{
			Result: "error",
			Size:   info.Size(),
			Error:  "cannot preview non-regular file",
		}, nil
	}

	size := info.Size()
	if size > req.MaxBytes {
		return ReadFileResult{
			Result: "error",
			Size:   size,
			Error:  fmt.Sprintf("file is too large to preview (%d bytes, max %d)", size, req.MaxBytes),
		}, nil
	}

	ext := strings.ToLower(filepath.Ext(abs))
	if mime, ok := imageMIMEByExt[ext]; ok {
		data, err := os.ReadFile(abs)
		if err != nil {
			return ReadFileResult{}, err
		}
		return ReadFileResult{
			Result: "image",
			MIME:   mime,
			Base64: base64.StdEncoding.EncodeToString(data),
			Size:   int64(len(data)),
		}, nil
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return ReadFileResult{}, err
	}
	if isLikelyText(data) {
		return ReadFileResult{
			Result:  "text",
			Content: string(data),
			Size:    int64(len(data)),
		}, nil
	}
	return ReadFileResult{
		Result: "binary",
		Size:   int64(len(data)),
	}, nil
}

// isLikelyText returns true when the buffer reads like text. The
// heuristic: any NUL byte ⇒ binary; otherwise ≥ 90% of the first 8 KiB
// are printable ASCII, common whitespace, or high bytes (covers UTF-8
// multibyte continuation). Cheap, no allocations, and good enough for
// the preview gating decision — false positives just show garbled text
// in the viewer, false negatives show a "binary" placeholder.
func isLikelyText(b []byte) bool {
	if len(b) == 0 {
		return true
	}
	n := len(b)
	if n > 8192 {
		n = 8192
	}
	var printable int
	for i := 0; i < n; i++ {
		c := b[i]
		if c == 0 {
			return false
		}
		if c >= 0x20 || c == '\n' || c == '\r' || c == '\t' {
			printable++
		}
	}
	return float64(printable)/float64(n) >= 0.9
}

// loadGitignore builds a matcher rooted at `root`. Missing .gitignore
// is NOT an error — we return an empty matcher so callers can treat
// the nil-check uniformly.
func loadGitignore(root string) (*gitignore.GitIgnore, error) {
	path := filepath.Join(root, ".gitignore")
	if _, err := os.Stat(path); err != nil {
		return gitignore.CompileIgnoreLines(), nil
	}
	return gitignore.CompileIgnoreFile(path)
}
