// Package quota probes each installed coding-CLI's plan quota and
// caches the latest result for the daemon's heartbeat to piggy-back.
//
// Why this lives in the sidecar:
//
//   - The CLIs themselves don't surface quota on their command line.
//     They hit undocumented vendor endpoints (the same ones their own
//     /status pages call) using OAuth tokens stashed on disk after the
//     user logged in via `claude /login` or `codex login`.
//   - Only the box running those CLIs has the OAuth tokens. Sending the
//     tokens to the server to call upstream from there would needlessly
//     widen the trust boundary; doing the calls locally and forwarding
//     just the resulting numbers is cheaper and safer.
//
// Probing happens in a single goroutine on a slow tick (refreshInterval).
// The Anthropic endpoint is reportedly aggressive about rate-limiting
// (issue #31021), so we default to once every five minutes — enough for
// a dashboard rendering the data on demand, well under any sensible
// vendor cap.
//
// Failures are reported per-row, not collapsed: an expired token, a
// vendor 5xx, or a network blip surfaces as `Error` on that one
// AgentQuota and the dashboard renders it as "unknown". This way users
// can tell "I never logged into codex" (row absent) from "my codex
// token expired" (row present, with reason).
package quota

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

const (
	// refreshInterval is how often the prober refreshes every CLI's
	// quota. Five minutes is a deliberate compromise: rare enough to
	// stay clear of the vendor rate-limits we observed during research
	// (Anthropic /api/oauth/usage starts returning 429 if hit at human-
	// click cadence — issue #31021), frequent enough that a dashboard
	// open right after a long agent run reflects up-to-date numbers.
	refreshInterval = 5 * time.Minute

	// httpTimeout caps every probe's round-trip. Bumped past the more
	// typical 5s used for `--version` probes because both vendor
	// endpoints are CDN-fronted and occasionally take a second or two
	// to respond, and the prober already runs out of band — a slow
	// probe doesn't block heartbeat publishing.
	httpTimeout = 10 * time.Second
)

// Probe is one CLI's "go fetch the latest quota" function. Returns
// AgentQuota with `Error` populated and `Windows` empty on failure
// (rather than returning a Go error) so the result can be cached and
// surfaced to the dashboard verbatim. Returning (nil, nil) means
// "this CLI is unconfigured on this machine" (no auth file, no API
// key) and the prober drops the row entirely instead of caching a
// permanent "no auth" error.
type Probe func(ctx context.Context, now time.Time) (*protocol.AgentQuota, error)

// Prober is the daemon-owned coordinator. Run() loops, each tick
// probing every registered CLI in parallel and replacing the cached
// snapshot. Latest() returns whatever was last cached — empty until
// the first tick completes.
//
// Thread-safe: Run is meant for a single goroutine; Latest can be
// called from any goroutine.
type Prober struct {
	probes []probeEntry
	log    *log.Logger
	client *http.Client

	mu     sync.RWMutex
	latest []protocol.AgentQuota
}

type probeEntry struct {
	name string
	fn   Probe
}

// New builds a Prober wired to the default per-CLI probe set.
func New(logger *log.Logger) *Prober {
	client := &http.Client{Timeout: httpTimeout}
	return &Prober{
		probes: []probeEntry{
			{name: "claude-code", fn: claudeCodeProbe(client)},
			{name: "codex", fn: codexProbe(client)},
			{name: "cursor-cli", fn: cursorProbe(client)},
		},
		log:    logger,
		client: client,
	}
}

// Run drives the refresh loop. Returns when ctx is cancelled.
//
// The first tick fires immediately (rather than waiting refreshInterval)
// so the very first machine-heartbeat after boot — which lands ~5s in —
// already carries fresh data. Without this the dashboard would render
// "no quota data yet" for the first five minutes after a sidecar restart.
func (p *Prober) Run(ctx context.Context) {
	p.refresh(ctx)
	t := time.NewTicker(refreshInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.refresh(ctx)
		}
	}
}

// Latest returns a copy of the most recently cached quota set. Empty
// slice (not nil) when no probes have completed yet, so callers can
// `append(..., quotas...)` without nil-checking. The MachineHeartbeatEvent
// uses `omitempty`, so an empty slice is correctly elided on the wire.
func (p *Prober) Latest() []protocol.AgentQuota {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if len(p.latest) == 0 {
		return []protocol.AgentQuota{}
	}
	out := make([]protocol.AgentQuota, len(p.latest))
	copy(out, p.latest)
	return out
}

// refresh runs every probe in parallel. Probes that return
// (nil, nil) (= no auth file at all) are dropped; probes that return
// non-nil populate either Windows or Error and are cached as-is.
func (p *Prober) refresh(ctx context.Context) {
	now := time.Now()
	results := make([]*protocol.AgentQuota, len(p.probes))
	var wg sync.WaitGroup
	wg.Add(len(p.probes))
	for i, e := range p.probes {
		i, e := i, e
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					p.log.Printf("quota: %s probe panicked: %v", e.name, r)
				}
			}()
			out, err := e.fn(ctx, now)
			if err != nil {
				p.log.Printf("quota: %s probe failed: %v", e.name, err)
				return
			}
			results[i] = out
		}()
	}
	wg.Wait()

	next := make([]protocol.AgentQuota, 0, len(results))
	for _, r := range results {
		if r == nil {
			continue
		}
		next = append(next, *r)
	}
	p.mu.Lock()
	p.latest = next
	p.mu.Unlock()
}

// errNoAuth signals "this CLI isn't configured on this box" — the
// prober drops the row entirely so the dashboard doesn't see a
// permanent "no auth" error for adapters the user simply hasn't
// signed into. Probe implementations check for this with errors.Is.
var errNoAuth = fmt.Errorf("no auth configured")

// httpGetJSON is a tiny shared helper: GET, expect JSON, return body
// + status code. Returns the body even on non-2xx so callers can
// surface a useful slice of the upstream error in their AgentQuota.Error.
func httpGetJSON(ctx context.Context, client *http.Client, rawURL string, headers map[string]string) (int, []byte, error) {
	return httpJSON(ctx, client, http.MethodGet, rawURL, nil, headers)
}

// httpPostJSON mirrors httpGetJSON for endpoints the sidecar has to
// POST to. The body is sent verbatim and `Content-Type: application/json`
// is set automatically (unless the caller overrides it via headers).
func httpPostJSON(ctx context.Context, client *http.Client, rawURL string, body []byte, headers map[string]string) (int, []byte, error) {
	return httpJSON(ctx, client, http.MethodPost, rawURL, body, headers)
}

func httpJSON(ctx context.Context, client *http.Client, method, rawURL string, body []byte, headers map[string]string) (int, []byte, error) {
	if _, err := url.Parse(rawURL); err != nil {
		return 0, nil, fmt.Errorf("bad url: %w", err)
	}
	var reqBody io.Reader
	if body != nil {
		reqBody = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reqBody)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	// Bumped past 1 MiB because Cursor's get-team-spend returns the
	// entire team roster in one shot — ~600 KB on a ~5k-seat enterprise
	// account. 4 MiB still cheaply caps a runaway payload.
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, respBody, nil
}

// readJSONFile reads a small JSON file from disk into the destination.
// Returns errNoAuth (not a wrapped fs.ErrNotExist) so callers can
// distinguish "no auth file" from "auth file present but malformed."
func readJSONFile(path string, dst any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return errNoAuth
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

// truncate is used to bound how much of an upstream error body we
// stuff into AgentQuota.Error before publishing — error strings ride
// the same lifecycle stream as everything else, no point making them
// unbounded.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
