// Package machine — secondary fsnotify watcher dedicated to git
// state. The primary fsWatcher (fswatch.go) hard-skips `.git/` to
// avoid burning inotify budget on object writes, packfile churn, and
// lock files. That's the right call for the file tree, but it means
// the dashboard never learns about commits, branch checkouts, or
// resets unless the user clicks refresh.
//
// gitWatcher closes that gap with a tiny, narrowly-scoped watcher: it
// watches `.git/` directly (one watch on the dir, plus one on
// `.git/refs/heads/` for branch tip movement) and emits a single
// debounced "git changed" callback per quiet window. Object-write
// noise IS observed but never propagated past the debounce — the
// callback fires once per checkout / commit / reset regardless of
// how many object files git rewrote.
package machine

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// gitWatcherDebounce is longer than fsWatcherDebounce because git
// operations write a flurry of files (loose objects, lockfile dance,
// HEAD update) over a few hundred ms. 500 ms collapses a normal
// commit / rebase step / merge into one event.
const gitWatcherDebounce = 500 * time.Millisecond

// gitWatcher tracks `.git/HEAD` and `.git/refs/heads/`. We don't
// watch the entire `.git/` recursively because (a) loose-object dirs
// are noisy and not interesting on their own, and (b) packfile
// rewrites trip BIG bursts of CREATE/REMOVE pairs we'd rather not
// process. HEAD + refs/heads/ between them cover commits (HEAD's
// ref's tip moves), checkouts (HEAD's ref-pointer changes),
// resets / amends (ref tip moves), and rebases (HEAD detaches and
// re-attaches).
type gitWatcher struct {
	gitDir string
	inner  *fsnotify.Watcher
	emit   func()
	log    *log.Logger

	mu     sync.Mutex
	timer  *time.Timer
	closed bool
}

// newGitWatcher resolves the workingDir's .git location and starts
// watching the relevant ref files. Returns (nil, nil) for non-repos
// — the supervisor treats that as "no panel auto-refresh" and falls
// through silently.
//
// Failures during fsnotify registration are logged and surfaced as
// errors so the supervisor can fall back to manual-refresh-only,
// matching how fsWatcher fails open.
func newGitWatcher(ctx context.Context, workingDir string, emit func(), logger *log.Logger) (*gitWatcher, error) {
	if workingDir == "" {
		return nil, errors.New("gitwatch: empty workingDir")
	}
	gitDir, err := resolveGitDir(workingDir)
	if err != nil {
		return nil, err
	}
	if gitDir == "" {
		// Not a git repo — caller should not log this as an error.
		return nil, nil
	}
	inner, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &gitWatcher{
		gitDir: gitDir,
		inner:  inner,
		emit:   emit,
		log:    logger,
	}

	// Watch `.git/` itself for HEAD changes (HEAD is a file directly
	// under gitDir, fsnotify only delivers events on watched DIRS so
	// we observe modifications to children of gitDir, not the file
	// directly).
	if err := inner.Add(gitDir); err != nil {
		_ = inner.Close()
		return nil, err
	}
	// Watch refs/heads/ for branch tip movement (commits, resets,
	// amends). Missing on a brand-new init'd repo with no branches —
	// treat as soft failure.
	headsDir := filepath.Join(gitDir, "refs", "heads")
	if _, err := os.Stat(headsDir); err == nil {
		if addErr := inner.Add(headsDir); addErr != nil {
			logger.Printf("gitwatch: add %s: %v", headsDir, addErr)
		}
	}
	// `packed-refs` is a single file directly under gitDir (already
	// covered by the gitDir watch above) — `git gc` collapses loose
	// refs into it and a packed-refs rewrite IS a state change worth
	// surfacing. No extra watch needed.

	go w.loop(ctx)
	return w, nil
}

// Close stops the watcher. Idempotent.
func (w *gitWatcher) Close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	w.mu.Unlock()
	_ = w.inner.Close()
}

func (w *gitWatcher) loop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			w.Close()
			return
		case ev, ok := <-w.inner.Events:
			if !ok {
				return
			}
			w.handleEvent(ev)
		case err, ok := <-w.inner.Errors:
			if !ok {
				return
			}
			w.log.Printf("gitwatch: %v", err)
		}
	}
}

// handleEvent filters fsnotify noise down to "the dashboard cares
// about this" before scheduling a debounced emit. Two filters:
//
//  1. We only watch HEAD and refs/heads/, but fsnotify on a directory
//     reports every child event including .lock files git uses
//     during ref updates. Drop *.lock so a single ref bump doesn't
//     fire the debounce twice (unlock event arrives ~ms after the
//     write).
//  2. We ignore ATTRIB-only events; git rewrites timestamps on every
//     `git status` and we don't want to refresh on read-only ops.
func (w *gitWatcher) handleEvent(ev fsnotify.Event) {
	if filepath.Ext(ev.Name) == ".lock" {
		return
	}
	if ev.Op == fsnotify.Chmod {
		return
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	if w.timer == nil {
		w.timer = time.AfterFunc(gitWatcherDebounce, w.flush)
	}
}

func (w *gitWatcher) flush() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.timer = nil
	w.mu.Unlock()
	w.emit()
}
