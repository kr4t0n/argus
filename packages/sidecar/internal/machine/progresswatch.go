// Package machine — per-agent progress watcher.
//
// Watches `<workingDir>/.argus/progress/` for the JSONL streams that
// `argus-bg` writes when it wraps a long-running command. Each new
// line in any `*.jsonl` file is decoded and forwarded to the
// supervisor, which republishes it as a BackgroundTask{Started,
// Progress,Ended} lifecycle event so the dashboard can render the
// per-project Progress tab.
//
// The watcher exists because once a wrapped command backgrounds
// itself (`&` / `nohup`), its output no longer flows through the
// agent's PTY — the only signal left on disk is whatever the agent
// writes to its log files. argus-bg standardizes that log into a
// machine-readable JSONL contract so we don't have to scrape PTY
// bytes after the fact.
package machine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// bgEvent is the shape of one JSONL line written by argus-bg. All
// fields are optional except `Type` + `ID`; which set is populated
// depends on the discriminator:
//
//	"start"    Label, Cmd, Cwd, PID, StartedAt
//	"progress" Current, Total, Percent, EtaSeconds, Rate, Unit, Desc
//	"end"      ExitCode, Status, EndedAt
type bgEvent struct {
	Type       string   `json:"type"`
	ID         string   `json:"id"`
	Label      string   `json:"label,omitempty"`
	Cmd        []string `json:"cmd,omitempty"`
	Cwd        string   `json:"cwd,omitempty"`
	PID        int      `json:"pid,omitempty"`
	StartedAt  int64    `json:"startedAt,omitempty"`
	Current    int64    `json:"current,omitempty"`
	Total      int64    `json:"total,omitempty"`
	Percent    float64  `json:"percent,omitempty"`
	EtaSeconds float64  `json:"etaSeconds,omitempty"`
	Rate       float64  `json:"rate,omitempty"`
	Unit       string   `json:"unit,omitempty"`
	Desc       string   `json:"desc,omitempty"`
	ExitCode   int      `json:"exitCode,omitempty"`
	Status     string   `json:"status,omitempty"`
	EndedAt    int64    `json:"endedAt,omitempty"`
	TS         int64    `json:"ts,omitempty"`
}

// progressWatcher tracks every `*.jsonl` file under root and emits one
// callback per decoded line. Files are opened from offset 0 the first
// time they're seen so an already-written `start` event isn't missed —
// after a restart we may re-emit history, which the server dedupes
// by taskId.
type progressWatcher struct {
	root  string
	inner *fsnotify.Watcher
	emit  func(bgEvent)
	log   *log.Logger

	mu     sync.Mutex
	tails  map[string]*fileTailer
	closed bool
}

type fileTailer struct {
	f       *os.File
	reader  *bufio.Reader
	partial strings.Builder
}

// newProgressWatcher creates the watcher rooted at
// <workingDir>/.argus/progress/. The directory is MkdirAll'd on
// startup so a fresh project (no argus-bg run yet) still gets a watch
// in place. Soft-fails the same way fsw/gitw do: returns an error and
// the supervisor logs + carries on without live progress events.
func newProgressWatcher(ctx context.Context, workingDir string, emit func(bgEvent), logger *log.Logger) (*progressWatcher, error) {
	if workingDir == "" {
		return nil, errors.New("progresswatch: empty workingDir")
	}
	root := filepath.Join(workingDir, ".argus", "progress")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	inner, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &progressWatcher{
		root:  root,
		inner: inner,
		emit:  emit,
		log:   logger,
		tails: make(map[string]*fileTailer),
	}
	if err := inner.Add(root); err != nil {
		_ = inner.Close()
		return nil, err
	}
	w.scanExisting()
	go w.loop(ctx)
	return w, nil
}

// Close stops the watcher and closes any open file handles.
// Idempotent.
func (w *progressWatcher) Close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	tails := w.tails
	w.tails = nil
	w.mu.Unlock()
	for _, t := range tails {
		_ = t.f.Close()
	}
	_ = w.inner.Close()
}

// scanExisting catches up on any *.jsonl files that already exist
// when the watcher starts. Each is opened from offset 0 and fully
// drained before the loop begins consuming fsnotify events.
func (w *progressWatcher) scanExisting() {
	entries, err := os.ReadDir(w.root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		path := filepath.Join(w.root, e.Name())
		w.openTail(path)
		w.readNew(path)
	}
}

func (w *progressWatcher) loop(ctx context.Context) {
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
			w.log.Printf("progresswatch: %v", err)
		}
	}
}

func (w *progressWatcher) handleEvent(ev fsnotify.Event) {
	if filepath.Ext(ev.Name) != ".jsonl" {
		return
	}
	switch {
	case ev.Op&fsnotify.Create != 0:
		w.openTail(ev.Name)
		w.readNew(ev.Name)
	case ev.Op&fsnotify.Write != 0:
		// New writers may emit Write before we ever saw a Create
		// (race on watcher startup); openTail is idempotent.
		w.openTail(ev.Name)
		w.readNew(ev.Name)
	case ev.Op&fsnotify.Remove != 0 || ev.Op&fsnotify.Rename != 0:
		w.closeTail(ev.Name)
	}
}

func (w *progressWatcher) openTail(path string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	if _, exists := w.tails[path]; exists {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		w.log.Printf("progresswatch: open %s: %v", path, err)
		return
	}
	w.tails[path] = &fileTailer{f: f, reader: bufio.NewReader(f)}
}

func (w *progressWatcher) closeTail(path string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if t, ok := w.tails[path]; ok {
		_ = t.f.Close()
		delete(w.tails, path)
	}
}

// readNew drains every complete JSONL line available on the tailer
// for path. Incomplete lines (the typical EOF-mid-write case) stay in
// the tailer's partial buffer until the next Write event flushes
// them. bufio.Reader transparently re-reads from the underlying file
// after a prior io.EOF — the EOF is consumed and cleared on next
// access — which is exactly the "tail -f" behavior we want.
func (w *progressWatcher) readNew(path string) {
	w.mu.Lock()
	t, ok := w.tails[path]
	w.mu.Unlock()
	if !ok {
		return
	}
	for {
		line, err := t.reader.ReadString('\n')
		if line != "" {
			t.partial.WriteString(line)
			if strings.HasSuffix(line, "\n") {
				full := strings.TrimRight(t.partial.String(), "\n")
				t.partial.Reset()
				w.dispatch(full)
			}
		}
		if err == io.EOF {
			return
		}
		if err != nil {
			w.log.Printf("progresswatch: read %s: %v", path, err)
			return
		}
	}
}

func (w *progressWatcher) dispatch(line string) {
	if line == "" {
		return
	}
	var ev bgEvent
	if err := json.Unmarshal([]byte(line), &ev); err != nil {
		w.log.Printf("progresswatch: bad json: %v", err)
		return
	}
	if ev.Type == "" || ev.ID == "" {
		return
	}
	w.emit(ev)
}
