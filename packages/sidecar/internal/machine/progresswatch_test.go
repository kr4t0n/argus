package machine

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestProgressWatcher_EmitsScannedAndNewLines walks the full happy
// path: a JSONL file already on disk when the watcher starts, plus
// fresh writes after, plus an end event. The watcher should emit
// every line on the callback in order.
func TestProgressWatcher_EmitsScannedAndNewLines(t *testing.T) {
	workdir := t.TempDir()
	root := filepath.Join(workdir, ".argus", "progress")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir progress: %v", err)
	}

	// Pre-existing file the watcher should drain on startup.
	preexisting := filepath.Join(root, "task-a.jsonl")
	if err := os.WriteFile(preexisting, []byte(
		`{"type":"start","id":"task-a","label":"pre","startedAt":1,"ts":1}`+"\n",
	), 0o644); err != nil {
		t.Fatalf("write preexisting: %v", err)
	}

	var (
		mu       sync.Mutex
		received []bgEvent
	)
	emit := func(ev bgEvent) {
		mu.Lock()
		received = append(received, ev)
		mu.Unlock()
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logger := log.New(os.Stderr, "[test] ", 0)
	w, err := newProgressWatcher(ctx, workdir, emit, logger)
	if err != nil {
		t.Fatalf("newProgressWatcher: %v", err)
	}
	defer w.Close()

	// Brand-new file created after the watcher is running.
	fresh := filepath.Join(root, "task-b.jsonl")
	f, err := os.Create(fresh)
	if err != nil {
		t.Fatalf("create fresh: %v", err)
	}
	defer f.Close()

	_, _ = f.WriteString(`{"type":"start","id":"task-b","label":"fresh","startedAt":2,"ts":2}` + "\n")
	_, _ = f.WriteString(`{"type":"progress","id":"task-b","current":50,"total":100,"percent":50,"ts":3}` + "\n")
	_, _ = f.WriteString(`{"type":"end","id":"task-b","exitCode":0,"status":"done","endedAt":4,"ts":4}` + "\n")
	_ = f.Sync()

	// Wait for the watcher to drain everything.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(received)
		mu.Unlock()
		if n >= 4 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(received) < 4 {
		t.Fatalf("got %d events, want at least 4: %+v", len(received), received)
	}

	// Pre-existing start event must appear before the fresh file's
	// events (scanExisting drains synchronously before loop starts).
	if received[0].Type != "start" || received[0].ID != "task-a" {
		t.Fatalf("first event = %+v, want start task-a", received[0])
	}

	// Fresh file events arrive in write order.
	want := []struct {
		typ, id string
	}{
		{"start", "task-b"},
		{"progress", "task-b"},
		{"end", "task-b"},
	}
	for i, w := range want {
		got := received[i+1]
		if got.Type != w.typ || got.ID != w.id {
			t.Errorf("event[%d] = (%s, %s), want (%s, %s)", i+1, got.Type, got.ID, w.typ, w.id)
		}
	}

	// Spot-check that a progress event carried its numeric payload.
	if received[2].Current != 50 || received[2].Total != 100 || received[2].Percent != 50 {
		t.Errorf("progress payload mis-decoded: %+v", received[2])
	}
}

// TestProgressWatcher_IgnoresNonJSONLFiles verifies the watcher
// doesn't open / try to parse files outside the *.jsonl filter, so a
// stray README or .tmp file in the progress dir doesn't crash it.
func TestProgressWatcher_IgnoresNonJSONLFiles(t *testing.T) {
	workdir := t.TempDir()
	root := filepath.Join(workdir, ".argus", "progress")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir progress: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "README.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("write readme: %v", err)
	}

	var received []bgEvent
	emit := func(ev bgEvent) { received = append(received, ev) }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logger := log.New(os.Stderr, "[test] ", 0)
	w, err := newProgressWatcher(ctx, workdir, emit, logger)
	if err != nil {
		t.Fatalf("newProgressWatcher: %v", err)
	}
	defer w.Close()

	time.Sleep(100 * time.Millisecond)
	if len(received) != 0 {
		t.Errorf("expected zero events from non-jsonl files, got %d: %+v", len(received), received)
	}
}
