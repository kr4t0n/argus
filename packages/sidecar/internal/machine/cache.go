// Package machine implements the per-host argus-sidecar daemon: the
// long-lived process that registers itself as a Machine with the server,
// supervises N agent subprocesses (one per Agent row the dashboard
// created), and persists its identity + agent set to disk so it can
// re-spawn agents instantly on restart without waiting for the server
// link.
package machine

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// CacheSchemaVersion is bumped whenever the on-disk cache shape changes.
// Older versions are migrated forward in Load(); incompatible bumps
// trigger an outright rewrite (the sidecar can always re-derive
// machineId/availableAdapters; only the agent set is operator-defined).
const CacheSchemaVersion = 1

// Cache is the on-disk JSON the sidecar stores at ~/.config/argus/sidecar.json.
//
// Persisted fields are deliberately minimal: identity, bus URL, server
// link credentials, the most recent canonical agent list. Everything
// else (host info, available adapters, sidecar version) is recomputed
// on boot — those values can change with a binary upgrade or a system
// rename, and we don't want stale snapshots to drive the wire register.
type Cache struct {
	SchemaVersion int           `json:"schemaVersion"`
	MachineID     string        `json:"machineId"`
	Name          string        `json:"name"`
	Bus           string        `json:"bus"`
	Server        ServerConfig  `json:"server"`
	Agents        []AgentRecord `json:"agents"`
}

// ServerConfig is the direct sidecar↔server link config (terminal
// transport). Mirrors the fields the old YAML carried under `server:`.
type ServerConfig struct {
	URL   string `json:"url"`
	Token string `json:"token,omitempty"`
}

// AgentRecord is the cached canonical form of a server-managed agent.
// Mirrors protocol.AgentSpec — duplicated rather than aliased so we
// can evolve the on-disk shape independently of the wire shape.
type AgentRecord struct {
	AgentID          string         `json:"agentId"`
	Name             string         `json:"name"`
	Type             string         `json:"type"`
	WorkingDir       string         `json:"workingDir,omitempty"`
	SupportsTerminal bool           `json:"supportsTerminal"`
	Adapter          map[string]any `json:"adapter,omitempty"`
}

// DefaultPath returns the canonical cache location, honoring
// XDG_CONFIG_HOME on linux/macOS. Falls back to ~/.config/argus on
// systems without an XDG dir (which still works on macOS — Apple's
// HIG-blessed Application Support is too noisy for an opt-in dev tool).
func DefaultPath() (string, error) {
	if dir := os.Getenv("ARGUS_CONFIG_DIR"); dir != "" {
		return filepath.Join(dir, "sidecar.json"), nil
	}
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "argus", "sidecar.json"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate home dir: %w", err)
	}
	return filepath.Join(home, ".config", "argus", "sidecar.json"), nil
}

// Load reads the cache from disk. Returns os.ErrNotExist when the file
// is missing so callers can distinguish "first boot" from "corrupt".
func Load(path string) (*Cache, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	body, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var c Cache
	if err := json.Unmarshal(body, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.SchemaVersion == 0 {
		// Treat a missing schema field as v1 (we shipped v1 with the
		// field always populated, but be lenient on hand-edited files).
		c.SchemaVersion = CacheSchemaVersion
	}
	if c.SchemaVersion > CacheSchemaVersion {
		return nil, fmt.Errorf(
			"cache schema v%d is newer than this sidecar (v%d); upgrade the sidecar binary",
			c.SchemaVersion, CacheSchemaVersion,
		)
	}
	if c.MachineID == "" {
		return nil, fmt.Errorf("%s: missing machineId (run `argus-sidecar init --force`)", path)
	}
	if c.Bus == "" {
		return nil, fmt.Errorf("%s: missing bus (run `argus-sidecar init --force`)", path)
	}
	return &c, nil
}

// Save writes the cache to disk atomically (write-tmp + rename).
// Creates the parent directory with 0700 and the file with 0600 — the
// cache holds the bus URL (often credentialed) and the sidecar link
// token, neither of which should be world-readable.
func Save(path string, c *Cache) error {
	if c == nil {
		return errors.New("nil cache")
	}
	if c.SchemaVersion == 0 {
		c.SchemaVersion = CacheSchemaVersion
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	body, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "sidecar.json.*.tmp")
	if err != nil {
		return fmt.Errorf("tempfile: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if err := os.Chmod(tmpName, 0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("chmod %s: %w", tmpName, err)
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write %s: %w", tmpName, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("fsync %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename %s -> %s: %w", tmpName, path, err)
	}
	cleanup = false
	return nil
}

// NewMachineID mints a fresh UUIDv4 string. Centralized here so init/
// daemon use the same source.
func NewMachineID() string { return uuid.NewString() }

// DetectMachineName returns a reasonable default for Cache.Name on a
// host that hasn't been initialized yet. Prefers os.Hostname() — stable
// across reboots and naturally distinct across a fleet — and strips the
// macOS Bonjour `.local` suffix, which clutters the dashboard without
// adding signal.
//
// On hostname-less environments (rare; sandboxed containers) we fall
// back to "machine-<short uuid>" so init still produces something
// usable; the operator can always rename via `argus-sidecar init --force`.
func DetectMachineName() string {
	hn, err := os.Hostname()
	if err == nil {
		if normalized := normalizeHostname(hn); normalized != "" {
			return normalized
		}
	}
	id := uuid.NewString()
	return "machine-" + id[:8]
}

// normalizeHostname applies the trimming rules described on
// DetectMachineName. Split out so it can be unit-tested independently
// of os.Hostname() (which we don't want to mock in tests).
func normalizeHostname(hn string) string {
	hn = strings.TrimSpace(hn)
	hn = strings.TrimSuffix(hn, ".local")
	return hn
}
