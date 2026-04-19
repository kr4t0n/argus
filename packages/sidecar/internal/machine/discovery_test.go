package machine

import (
	"context"
	"testing"

	"github.com/kyley/argus/sidecar/internal/adapter"
)

func TestDiscoverFiltersToInstalledAdapters(t *testing.T) {
	// Register a synthetic adapter pointing at a binary that definitely
	// won't exist on PATH; Discover must omit it.
	adapter.Register("__nonexistent_for_test__", adapter.Plugin{
		DefaultBinary: "argus-this-binary-does-not-exist-xyz",
		Factory: func(map[string]any) (adapter.Adapter, error) {
			t.Fatalf("factory should not be called from Discover")
			return nil, nil
		},
	})

	got := Discover(context.Background())
	for _, a := range got {
		if a.Type == "__nonexistent_for_test__" {
			t.Errorf("Discover returned non-installed adapter: %+v", a)
		}
		if a.Binary == "" {
			t.Errorf("Discover returned empty binary path for %q", a.Type)
		}
	}
}
