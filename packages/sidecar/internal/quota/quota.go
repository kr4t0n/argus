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
	"crypto/sha256"
	"encoding/hex"
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

// Probe is one CLI's "go fetch the latest quota" function. Always
// returns a non-nil AgentQuota on the happy path:
//
//   - signed in: `Fingerprint` set, `Windows` populated.
//   - signed in but vendor refused / changed shape: `Fingerprint`
//     set, `Windows` empty, `Error` carries the reason.
//   - not signed in (auth file missing/empty): `Fingerprint=""` (the
//     tombstone sentinel), `Windows` empty, `Error="not signed in"`.
//
// The (nil, nil) escape hatch remains for panic safety, but the
// happy path is always one of the three above. Returning a tombstone
// instead of nil for the "not signed in" case is what lets the server
// clear out a previous good row when a user logs out — and the empty
// fingerprint keeps it from competing against real-account rows from
// other machines during `/me/quota` aggregation.
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

// errNoAuth signals "this CLI's auth file isn't present on this box."
// Probes turn it into a tombstone AgentQuota (Fingerprint="", empty
// Windows, Error="not signed in") so the server can replace any prior
// good row from this same machine without competing against real
// data from a different machine that's signed in.
var errNoAuth = fmt.Errorf("no auth configured")

// retryOnAuthFailure runs `once` twice if the first call returned
// authFailed=true. Returns the retry's row when the retry succeeded
// (no transport error); otherwise the first call's row.
//
// Why this exists: both Anthropic and OpenAI invalidate the previous
// access token the moment a refresh mints a new one, even though the
// JWT's `exp` claim is still hours away. The CLIs (claude-code,
// codex) silently refresh during normal use and rewrite their on-disk
// credential files afterwards. A probe that read just before the
// rewrite — but sent the request just after the server-side
// invalidation — gets a 401 even though the user's session is
// healthy. Re-reading the file and trying once more closes most of
// that race window without any sidecar-side refresh logic of our own
// (which would race the CLI in the other direction). No backoff:
// by the time we got the failed response back from the network, the
// CLI has overwhelmingly likely finished writing the new pair.
func retryOnAuthFailure(
	once func() (*protocol.AgentQuota, bool, error),
) (*protocol.AgentQuota, error) {
	row, authFailed, err := once()
	if err != nil {
		return nil, err
	}
	if !authFailed {
		return row, nil
	}
	row2, _, err2 := once()
	if err2 == nil && row2 != nil {
		return row2, nil
	}
	return row, nil
}

// fingerprintDomain prefixes every account-id we hash so fingerprints
// can't collide across CLIs (and so a leaked DB row's hash isn't
// directly searchable against, say, a published list of cursor
// workos ids without also knowing the prefix).
const fingerprintDomain = "argus-quota-fp-v1:"

// fingerprintFor returns the sidecar's stable per-account fingerprint:
// sha256(domain || ":" || source || ":" || rawID) hex. `source` is
// folded in so the same numeric/UUID id used by two different vendors
// never collides on the rare chance their id namespaces overlap.
//
// Empty rawID returns the empty string (the tombstone sentinel) — never
// hash "". A caller producing a tombstone should just pass "" directly.
func fingerprintFor(source, rawID string) string {
	if rawID == "" {
		return ""
	}
	h := sha256.New()
	h.Write([]byte(fingerprintDomain))
	h.Write([]byte(source))
	h.Write([]byte(":"))
	h.Write([]byte(rawID))
	return hex.EncodeToString(h.Sum(nil))
}

// tombstone builds an empty AgentQuota carrying just an error string.
// Used by every probe's "auth missing / unusable" paths so the server
// can replace the same machine's prior real row without the tombstone
// outranking other machines' real rows during `/me/quota` aggregation
// — that aggregation groups by (agentType, fingerprint), and tombstones
// always have fingerprint="" so they live in their own group.
func tombstone(now time.Time, agentType, source, reason string) *protocol.AgentQuota {
	return &protocol.AgentQuota{
		Type:        agentType,
		Source:      source,
		Fingerprint: "",
		Windows:     []protocol.QuotaWindow{},
		Error:       reason,
		CheckedAt:   now.UnixMilli(),
	}
}

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
