// Package machine — minimal git HEAD reader for the dashboard's
// branch badge.
//
// We deliberately don't shell out to `git` or pull in a Go git library
// (go-git is ~2MB of deps, libgit2 is a CGO headache, and `git` itself
// would be one more PATH dependency on the host). Instead we read
// .git/HEAD directly — it's a 2-line plain-text file and the format
// has been stable since git 1.x. Resolving linked-worktree pointers
// (where .git is a *file* not a *dir*) takes one extra read; that's
// the only quirk worth handling for v1.
//
// Out of scope (for now): dirty count, ahead/behind, rebase/merge
// state. The branch badge only needs the current branch name (or short
// SHA for detached HEAD), and bolting on richer status would push us
// toward shelling out to `git status --porcelain`, which is a much
// bigger commitment we'd rather defer until it's actually wanted.
package machine

import (
	"bufio"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/kyley/argus/sidecar/internal/protocol"
)

// shortHashLen matches `git rev-parse --short` default. Long enough to
// be unique in any reasonable repo, short enough to fit a badge.
const shortHashLen = 7

// ReadGitStatus inspects `workingDir` for a .git directory (or worktree
// pointer file) and returns the current HEAD's branch + short SHA.
//
// Returns (nil, nil) when the directory is not a git repo — that's the
// expected "no badge" path, not an error.
//
// Returns a non-nil error only for unexpected filesystem failures
// (permission denied, malformed HEAD file). Callers should log and
// fall through to "no badge" rather than surfacing this to the user;
// branch info is best-effort UX.
func ReadGitStatus(workingDir string) (*protocol.GitStatus, error) {
	if workingDir == "" {
		return nil, nil
	}
	gitDir, err := resolveGitDir(workingDir)
	if err != nil {
		return nil, err
	}
	if gitDir == "" {
		return nil, nil
	}
	headPath := filepath.Join(gitDir, "HEAD")
	f, err := os.Open(headPath)
	if err != nil {
		if os.IsNotExist(err) {
			// Repo dir present but no HEAD — corrupt or mid-clone. Treat
			// as not-a-repo for badge purposes.
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	// HEAD is a single line — either "ref: refs/heads/<branch>\n" or a
	// raw 40-char SHA (detached). bufio.Scanner caps at 64KB by default,
	// which is many orders of magnitude more than we need.
	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		if scanErr := scanner.Err(); scanErr != nil {
			return nil, scanErr
		}
		return nil, errors.New("empty .git/HEAD")
	}
	line := strings.TrimSpace(scanner.Text())

	if strings.HasPrefix(line, "ref: ") {
		ref := strings.TrimPrefix(line, "ref: ")
		branch := strings.TrimPrefix(ref, "refs/heads/")
		// Resolve the SHA the branch points at. Best-effort — packed
		// refs aren't read, so a freshly-packed repo will report an
		// empty head; we'd rather show "main" with no SHA than nothing.
		head := readRefSHA(gitDir, ref)
		return &protocol.GitStatus{
			Branch:   branch,
			Head:     head,
			Detached: false,
		}, nil
	}

	// Detached HEAD — the line is the raw SHA the working tree is
	// parked at. Trim to short form for display.
	sha := line
	if len(sha) > shortHashLen {
		sha = sha[:shortHashLen]
	}
	return &protocol.GitStatus{
		Branch:   "",
		Head:     sha,
		Detached: true,
	}, nil
}

// resolveGitDir returns the absolute path to the repo's .git directory,
// or "" when workingDir is not inside a repo.
//
// Handles the linked-worktree case: in a worktree, `.git` is a
// regular *file* with a single line `gitdir: <abspath>` pointing to
// the per-worktree subdir under the main repo's `.git/worktrees/`. We
// follow that pointer once.
//
// We deliberately do NOT walk parent directories. The agent's
// workingDir is the contract; if the user has nested checkouts, the
// badge reflects the working dir's repo, not some ancestor's.
func resolveGitDir(workingDir string) (string, error) {
	dotGit := filepath.Join(workingDir, ".git")
	info, err := os.Lstat(dotGit)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if info.IsDir() {
		return dotGit, nil
	}
	// Worktree pointer file — read "gitdir: <path>".
	data, err := os.ReadFile(dotGit)
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(line, "gitdir:"); ok {
			target := strings.TrimSpace(rest)
			if !filepath.IsAbs(target) {
				target = filepath.Join(workingDir, target)
			}
			return filepath.Clean(target), nil
		}
	}
	return "", nil
}

// readRefSHA returns the short SHA of `ref` (e.g. "refs/heads/main"),
// or "" when the ref isn't a loose file (packed refs, or a freshly
// initialised repo with no commits yet — both fine to leave empty).
func readRefSHA(gitDir, ref string) string {
	data, err := os.ReadFile(filepath.Join(gitDir, ref))
	if err != nil {
		return ""
	}
	sha := strings.TrimSpace(string(data))
	if len(sha) > shortHashLen {
		sha = sha[:shortHashLen]
	}
	return sha
}
