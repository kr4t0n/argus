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
	abs, err := resolvePath(req.WorkingDir, req.Path)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%q is not a directory", req.Path)
	}

	// We re-read .gitignore on every call rather than caching it on the
	// daemon. The listing itself dominates the cost (ReadDir + per-entry
	// stat), and rereading means edits surface immediately without us
	// needing an invalidation path.
	var matcher *gitignore.GitIgnore
	if !req.ShowAll {
		matcher, _ = loadGitignore(req.WorkingDir)
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		return nil, err
	}

	rootAbs, _ := filepath.Abs(req.WorkingDir)
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
		if !req.ShowAll && ignored {
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
