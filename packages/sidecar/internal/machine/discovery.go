package machine

import (
	"context"
	"os/exec"
	"sort"
	"time"

	"github.com/kyley/argus/sidecar/internal/adapter"
	"github.com/kyley/argus/sidecar/internal/protocol"
)

// Discover walks every registered adapter type, looks up its DefaultBinary
// on PATH, and — when found — invokes `<binary> --version` to populate the
// per-adapter availability record the dashboard's "create agent" UI uses
// to filter the type dropdown.
//
// Adapters with an empty DefaultBinary (i.e. non-CLI adapters, none today
// but kept open) are skipped silently.
//
// Discover is intentionally cheap: PATH lookups are syscalls, version
// probes get a 3s budget each (enforced inside ReadBinaryVersion) and
// the whole operation is bounded by ctx. A version probe that times out
// or errors does NOT remove the adapter from availability — we only need
// the binary to exist; version is a UX nicety.
func Discover(ctx context.Context) []protocol.AvailableAdapter {
	types := adapter.Types()
	sort.Strings(types) // stable order so the wire payload is deterministic

	out := make([]protocol.AvailableAdapter, 0, len(types))
	for _, t := range types {
		bin := adapter.DefaultBinary(t)
		if bin == "" {
			continue
		}
		path, err := exec.LookPath(bin)
		if err != nil {
			continue
		}
		ver := probeVersion(ctx, bin)
		out = append(out, protocol.AvailableAdapter{
			Type:    t,
			Binary:  path,
			Version: ver,
		})
	}
	return out
}

// probeVersion is a tolerant wrapper around adapter.ReadBinaryVersion:
// returns "" instead of an error so a flaky --version doesn't drop the
// adapter from the availability list. Each probe gets its own 3s budget
// derived from the parent ctx.
func probeVersion(parent context.Context, binary string) string {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	v, err := adapter.ReadBinaryVersion(ctx, binary)
	if err != nil {
		return ""
	}
	return v
}
