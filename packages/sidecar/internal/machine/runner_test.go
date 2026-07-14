package machine

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// The stream names are the Phase-3 wire contract with the TS server —
// a drift here silently strands every command, so pin the exact strings.
func TestRunnerStreamNaming(t *testing.T) {
	cmd := protocol.RunnerCommandStream("m-1", "claude-code")
	if cmd != "machine:m-1:cli:claude-code:cmd" {
		t.Fatalf("RunnerCommandStream = %q", cmd)
	}
	res := protocol.RunnerResultStream("m-1", "claude-code")
	if res != "machine:m-1:cli:claude-code:result" {
		t.Fatalf("RunnerResultStream = %q", res)
	}
	// The existing :cmd / :result suffix branches of StreamMaxLen must
	// cover the runner streams with the per-agent caps.
	if got := protocol.StreamMaxLen(cmd); got != 200 {
		t.Fatalf("StreamMaxLen(%q) = %d, want 200", cmd, got)
	}
	if got := protocol.StreamMaxLen(res); got != 500 {
		t.Fatalf("StreamMaxLen(%q) = %d, want 500", res, got)
	}
}

// SyncProjectsCommand must round-trip through JSON with the exact wire
// field names the server sends (kind / workdirs / ts).
func TestSyncProjectsCommandJSONRoundTrip(t *testing.T) {
	in := protocol.SyncProjectsCommand{
		Kind:     "sync-projects",
		Workdirs: []string{"/home/kyle/a", "/home/kyle/b"},
		TS:       1234567890,
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(b, &wire); err != nil {
		t.Fatalf("unmarshal to map: %v", err)
	}
	for _, key := range []string{"kind", "workdirs", "ts"} {
		if _, ok := wire[key]; !ok {
			t.Fatalf("wire payload missing %q: %s", key, b)
		}
	}
	var out protocol.SyncProjectsCommand
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("round trip mismatch: in=%+v out=%+v", in, out)
	}
}

// workdirAllowed is the fs/git jail boundary; it must track the
// sync-projects allowlist through reconciles (adds AND removals) and
// never admit the empty string.
func TestWorkdirAllowedFollowsReconciledAllowlist(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	logger := log.New(io.Discard, "", 0)
	cachePath := filepath.Join(t.TempDir(), "sidecar.json")
	d := New(cachePath, &Cache{MachineID: "m-test", Bus: "redis://unused"}, "0.3.0-test", logger)
	// bus stays nil: the registry only touches it when a watcher fires,
	// which these quiet temp dirs never do. Pre-create .argus/progress
	// so the progress watcher's MkdirAll doesn't itself trip the fresh
	// fs watcher.
	d.watchers = newWatchRegistry("m-test", nil, logger)

	wd1 := t.TempDir()
	wd2 := t.TempDir()
	for _, wd := range []string{wd1, wd2} {
		if err := os.MkdirAll(filepath.Join(wd, ".argus", "progress"), 0o755); err != nil {
			t.Fatalf("prepare workdir: %v", err)
		}
	}

	d.setWorkdirs(ctx, []string{wd1, wd2, wd1, ""}) // dupes + empties dropped
	if !d.workdirAllowed(wd1) || !d.workdirAllowed(wd2) {
		t.Fatalf("allowlisted workdirs must be allowed after reconcile")
	}
	if d.workdirAllowed("") {
		t.Fatal("empty workdir must never be allowed")
	}
	if d.workdirAllowed(filepath.Join(wd1, "sub")) {
		t.Fatal("non-allowlisted path must be rejected")
	}

	// Reconcile down: a removed workdir must stop being served.
	d.setWorkdirs(ctx, []string{wd2})
	if d.workdirAllowed(wd1) {
		t.Fatal("removed workdir must be rejected after reconcile")
	}
	if !d.workdirAllowed(wd2) {
		t.Fatal("retained workdir must stay allowed")
	}

	// The allowlist must survive a restart: setWorkdirs persists it.
	reloaded, err := Load(cachePath)
	if err != nil {
		t.Fatalf("reload cache: %v", err)
	}
	if !reflect.DeepEqual(reloaded.Workdirs, []string{wd2}) {
		t.Fatalf("persisted workdirs = %v, want [%s]", reloaded.Workdirs, wd2)
	}
}
