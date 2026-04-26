package adapter

import (
	"context"
	"fmt"
	"sync"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// Chunk is the unit the adapter emits back to the sidecar; the sidecar
// enriches it with seq/ids before publishing on Redis.
type Chunk struct {
	Kind       protocol.ResultKind
	Delta      string
	Content    string
	Meta       map[string]any
	IsFinal    bool
	ExternalID string // sent on the first chunk of a session to seed --resume
}

type Adapter interface {
	// Execute runs the given command and streams chunks on the returned channel.
	// The channel MUST be closed by the adapter when the turn is done.
	Execute(ctx context.Context, cmd protocol.Command) (<-chan Chunk, error)
	// Cancel requests a running command be aborted.
	Cancel(ctx context.Context, commandID string) error
	// Ping is a liveness check (e.g. confirm the CLI is present).
	Ping(ctx context.Context) error
}

// Versioned is an optional capability for adapters that can report the
// version of the CLI they wrap. Lifecycle queries this at register time
// so the dashboard shows the actual CLI version instead of a hand-rolled
// string from the sidecar YAML.
//
// Adapters that don't implement this interface fall back to cfg.Version
// (or the "unknown" sentinel) during registration.
type Versioned interface {
	Version(ctx context.Context) (string, error)
}

type Factory func(cfg map[string]any) (Adapter, error)

// Plugin bundles everything the registry needs to know about an adapter
// type *before* an instance is constructed. We separate this from the
// Adapter interface itself because boot-time discovery wants to probe
// for installed binaries without spending the cost of constructing a
// fully-validated adapter (which would also fail outright if the binary
// is missing).
type Plugin struct {
	// Factory builds an instance from a per-agent cfg map.
	Factory Factory
	// DefaultBinary is the conventional executable name to look up on
	// PATH during discovery (e.g. "claude", "codex", "cursor-agent").
	// Empty means the adapter is not auto-discoverable.
	DefaultBinary string
}

var (
	mu       sync.RWMutex
	registry = map[string]Plugin{}
)

// Register is called from each adapter file's init() function.
// Plugin.DefaultBinary may be empty for adapters that don't wrap a CLI.
func Register(typeName string, p Plugin) {
	mu.Lock()
	defer mu.Unlock()
	registry[typeName] = p
}

// New constructs an adapter by its type name.
func New(typeName string, cfg map[string]any) (Adapter, error) {
	mu.RLock()
	p, ok := registry[typeName]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown adapter type %q (did you forget an import?)", typeName)
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	return p.Factory(cfg)
}

// DefaultBinary returns the convention binary name for an adapter type,
// or "" when the type is unknown / non-CLI. Used by machine.discovery
// to probe PATH at sidecar boot.
func DefaultBinary(typeName string) string {
	mu.RLock()
	defer mu.RUnlock()
	return registry[typeName].DefaultBinary
}

// The sidecar-wide workingDir is injected into every adapter's cfg under
// this reserved key so adapters can pass it through to StreamSpec.Dir.
const WorkingDirKey = "_workingDir"

// WorkingDirFromCfg returns the sidecar-level working directory injected
// into the adapter cfg, or "" if none was configured.
func WorkingDirFromCfg(cfg map[string]any) string {
	if s, ok := cfg[WorkingDirKey].(string); ok {
		return s
	}
	return ""
}

// Types returns all registered type names (for debugging / --list-adapters).
func Types() []string {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]string, 0, len(registry))
	for k := range registry {
		out = append(out, k)
	}
	return out
}
