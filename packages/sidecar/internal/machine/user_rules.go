package machine

import (
	"os"
	"path/filepath"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// userRulesTargets maps adapter type → ($HOME-relative) path of the
// CLI's global rules file. We only sync to adapters the sidecar
// actually found on PATH at boot (see d.availableAdapters), so an
// adapter listed here that isn't installed is silently skipped.
//
// cursor-cli is intentionally absent: at the time of writing, it has
// no documented equivalent of CLAUDE.md / AGENTS.md, so we have
// nothing to write.
var userRulesTargets = map[string]string{
	"claude-code": ".claude/CLAUDE.md",
	"codex":       ".codex/AGENTS.md",
}

// handleSyncUserRules writes the user's saved rules text to every
// installed CLI's conventional rules file. Best-effort: per-target
// errors are logged but never block other targets, and the function
// never reports back to the server (sync is fire-and-forget; the
// authoritative copy lives in Postgres and the user can re-Save to
// retry).
//
// Empty Rules still rewrites the files — explicitly clearing the
// rules in the dashboard should propagate, not leave stale content
// behind on disk.
func (d *Daemon) handleSyncUserRules(ev protocol.SyncUserRulesCommand) {
	home, err := os.UserHomeDir()
	if err != nil {
		d.log.Printf("sync-user-rules: cannot resolve home dir: %v", err)
		return
	}

	wrote := 0
	for _, a := range d.availableAdapters {
		rel, ok := userRulesTargets[a.Type]
		if !ok {
			continue
		}
		path := filepath.Join(home, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			d.log.Printf("sync-user-rules: mkdir %s: %v", filepath.Dir(path), err)
			continue
		}
		if err := os.WriteFile(path, []byte(ev.Rules), 0o644); err != nil {
			d.log.Printf("sync-user-rules: write %s: %v", path, err)
			continue
		}
		wrote++
		d.log.Printf("sync-user-rules: wrote %d byte(s) to %s", len(ev.Rules), path)
	}
	d.log.Printf("sync-user-rules: synced %d/%d target(s)", wrote, len(userRulesTargets))
}
