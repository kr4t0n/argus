package adapter

import (
	"context"
	"fmt"
	"sync"

	"github.com/kyley/argus/sidecar/internal/protocol"
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

type Factory func(cfg map[string]any) (Adapter, error)

var (
	mu       sync.RWMutex
	registry = map[string]Factory{}
)

// Register is called from each adapter file's init() function.
func Register(typeName string, f Factory) {
	mu.Lock()
	defer mu.Unlock()
	registry[typeName] = f
}

// New constructs an adapter by its type name.
func New(typeName string, cfg map[string]any) (Adapter, error) {
	mu.RLock()
	f, ok := registry[typeName]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown adapter type %q (did you forget an import?)", typeName)
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	return f(cfg)
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
