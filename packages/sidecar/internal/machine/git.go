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
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
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

// gitLogDefaultLimit / gitLogMaxLimit bound how many commits the
// dashboard panel asks for. Defaults match the recommended scope (50
// rows visible without paging) and the cap matches the server-side
// validator so an over-large request can't drag the wire payload past
// a few KB. Each commit is ~150 bytes wire — 200 commits stays well
// under any meaningful threshold.
const (
	gitLogDefaultLimit = 50
	gitLogMaxLimit     = 200
)

// ReadGitLog returns the most recent N commits reachable from HEAD in
// `workingDir`. We shell out to `git log` rather than parsing
// `.git/objects/` ourselves: the binary is a hard runtime dependency
// for nearly every CLI agent we wrap (Claude / Codex / Cursor all
// shell out to git themselves) so requiring it is not a meaningful
// extra constraint, and the format-with-NUL-separators trick below
// gives us a robust parse with zero ambiguity around message bytes.
//
// Returns (nil, nil) when the directory is not a git repo. The
// "no commits yet" case (freshly init'd repo) returns ([], nil) — an
// empty list is a valid response, not an error.
//
// Error returns are reserved for unexpected failures (git not on PATH,
// exec rejected, malformed output). Callers should surface these to
// the dashboard as a panel-level error rather than swallowing.
func ReadGitLog(ctx context.Context, workingDir string, limit int) ([]protocol.GitCommit, error) {
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
	if limit <= 0 {
		limit = gitLogDefaultLimit
	}
	if limit > gitLogMaxLimit {
		limit = gitLogMaxLimit
	}

	// Field separator is NUL between columns. Records are separated by
	// `%x1e\n` because git's `--pretty=format:` joins commits with a
	// literal newline (the only inter-record glue we don't control), so
	// the on-wire record boundary is "our explicit RS byte, then git's
	// joining LF". Splitting on just `%x1e` would still work today —
	// `%s` (subject) is git's first-line-only token and we don't emit
	// `%b` — but pinning the LF here prevents a bug if a future field
	// addition (e.g. body, GPG sig) does carry an embedded RS.
	//
	// Format columns: full hash, subject, author name, author ISO date.
	const fieldSep = "\x00"
	const recordSep = "\x1e\n"
	format := "%H%x00%s%x00%an%x00%aI%x1e"

	cmd := exec.CommandContext(ctx, "git", "log",
		fmt.Sprintf("-n%d", limit),
		"--pretty=format:"+format,
		"--no-color",
	)
	cmd.Dir = workingDir
	out, err := cmd.Output()
	if err != nil {
		// "does not have any commits yet" is the empty-repo case —
		// `git log` exits 128 with that message on stderr. Surface
		// as an empty list, not an error.
		if exitErr, ok := err.(*exec.ExitError); ok {
			stderr := string(exitErr.Stderr)
			if strings.Contains(stderr, "does not have any commits") ||
				strings.Contains(stderr, "bad default revision") {
				return []protocol.GitCommit{}, nil
			}
			return nil, fmt.Errorf("git log: %w (%s)", err, strings.TrimSpace(stderr))
		}
		return nil, fmt.Errorf("git log: %w", err)
	}

	body := string(out)
	// Trim a trailing newline that some git versions append after the
	// final record.
	body = strings.TrimRight(body, "\n")
	if body == "" {
		return []protocol.GitCommit{}, nil
	}
	rawRecords := strings.Split(body, recordSep)
	commits := make([]protocol.GitCommit, 0, len(rawRecords))
	for _, rec := range rawRecords {
		// Final record may have a trailing %x1e with no NUL after it
		// (no record separator after the last commit). Strip the lone
		// %x1e if present.
		rec = strings.TrimSuffix(rec, "\x1e")
		if rec == "" {
			continue
		}
		fields := strings.SplitN(rec, fieldSep, 4)
		if len(fields) < 4 {
			continue
		}
		sha := fields[0]
		short := sha
		if len(short) > shortHashLen {
			short = short[:shortHashLen]
		}
		commits = append(commits, protocol.GitCommit{
			SHA:        sha,
			ShortSHA:   short,
			Subject:    fields[1],
			AuthorName: fields[2],
			AuthorDate: fields[3],
		})
	}
	return commits, nil
}
