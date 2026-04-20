// Package machine — per-agent recursive file watcher.
//
// Watches the agent's workingDir and emits debounced dir-level change
// notifications to the supervisor, which publishes them as
// FSChangedEvents on the lifecycle stream. Respects gitignore when
// registering watches so we don't burn inotify/FSEvents budget on
// node_modules / build artifacts / etc.
package machine

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	gitignore "github.com/sabhiram/go-gitignore"
)

const fsWatcherDebounce = 250 * time.Millisecond

// fsWatcher registers one fsnotify watch per non-ignored directory
// under root, and coalesces events into at-most-one emit() per dir per
// debounce window. Relative paths ("" means root) are passed to emit so
// the supervisor can forward them verbatim as FSChangedEvent.Path.
type fsWatcher struct {
	root    string
	matcher *gitignore.GitIgnore
	inner   *fsnotify.Watcher
	emit    func(relDir string)
	log     *log.Logger

	mu      sync.Mutex
	pending map[string]struct{}
	timer   *time.Timer
	closed  bool
}

// newFSWatcher starts watching `root` recursively (gitignore-aware)
// and returns a handle. Caller is responsible for Close()ing it. The
// background goroutine exits when Close is called OR ctx is cancelled.
//
// Silently degrades: if we can't even watch the root (permission
// denied, root doesn't exist, fsnotify blew up), we return an error
// and the caller skips live updates — the user can still browse the
// tree with manual refresh.
func newFSWatcher(ctx context.Context, root string, emit func(relDir string), logger *log.Logger) (*fsWatcher, error) {
	if root == "" {
		return nil, errors.New("watcher: empty root")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	abs = filepath.Clean(abs)
	inner, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	matcher, _ := loadGitignore(abs)
	w := &fsWatcher{
		root:    abs,
		matcher: matcher,
		inner:   inner,
		emit:    emit,
		log:     logger,
		pending: make(map[string]struct{}),
	}
	if err := w.walkAndRegister(abs); err != nil {
		_ = inner.Close()
		return nil, err
	}
	go w.loop(ctx)
	return w, nil
}

// Close stops the watcher. Idempotent.
func (w *fsWatcher) Close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	w.mu.Unlock()
	_ = w.inner.Close()
}

// ignoredDir reports whether abspath (or one of its parents between
// root and itself) should be skipped. We always skip `.git`.
func (w *fsWatcher) ignoredDir(abspath string) bool {
	if abspath == w.root {
		return false
	}
	rel, err := filepath.Rel(w.root, abspath)
	if err != nil {
		return true
	}
	rel = filepath.ToSlash(rel)
	if rel == ".git" || strings.HasPrefix(rel, ".git/") {
		return true
	}
	if w.matcher == nil {
		return false
	}
	return w.matcher.MatchesPath(rel + "/")
}

// walkAndRegister adds fsnotify watches for every non-ignored
// directory under `start`. `start` itself is always watched (even if
// gitignore would match it — the client explicitly asked for this
// root).
func (w *fsWatcher) walkAndRegister(start string) error {
	return filepath.WalkDir(start, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			// Missing/unreadable entries are non-fatal; skip silently.
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if p != start && w.ignoredDir(p) {
			return filepath.SkipDir
		}
		if addErr := w.inner.Add(p); addErr != nil {
			// Typically "too many open files" / EMFILE. Log once at
			// debug volume; future dirs will keep trying.
			w.log.Printf("fswatch: add %s: %v", p, addErr)
		}
		return nil
	})
}

func (w *fsWatcher) loop(ctx context.Context) {
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
			w.log.Printf("fswatch: %v", err)
		}
	}
}

// handleEvent routes one raw fsnotify event:
//  1. If it's a CREATE on a directory, walk it and register child watches
//     (inotify is non-recursive on Linux; macOS kqueue is per-dir too).
//  2. Mark the parent directory as dirty and schedule a flush.
//
// We intentionally ignore the file/dir that changed and bubble up only
// the parent — the dashboard's tree re-fetches by directory.
func (w *fsWatcher) handleEvent(ev fsnotify.Event) {
	if ev.Op&fsnotify.Create != 0 {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			if !w.ignoredDir(ev.Name) {
				if err := w.walkAndRegister(ev.Name); err != nil {
					w.log.Printf("fswatch: walk new dir %s: %v", ev.Name, err)
				}
			}
		}
	}

	dir := filepath.Dir(ev.Name)
	if w.ignoredDir(dir) {
		return
	}
	rel, err := filepath.Rel(w.root, dir)
	if err != nil {
		return
	}
	if rel == "." {
		rel = ""
	}
	rel = filepath.ToSlash(rel)

	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.pending[rel] = struct{}{}
	if w.timer == nil {
		w.timer = time.AfterFunc(fsWatcherDebounce, w.flush)
	}
	w.mu.Unlock()
}

func (w *fsWatcher) flush() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	paths := w.pending
	w.pending = make(map[string]struct{})
	w.timer = nil
	w.mu.Unlock()
	for p := range paths {
		w.emit(p)
	}
}
