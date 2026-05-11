package quota

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// claudeCodeProbe reads the user's claude-code OAuth credentials and
// calls two undocumented endpoints in series:
//
//   - /api/oauth/profile to get a stable per-account uuid (the CLI's
//     access tokens rotate, so they're useless as account identity).
//     We turn that uuid into the wire-level `fingerprint` so the
//     server can dedupe redundant reports of the same Anthropic
//     account across multiple machines and keep tombstones from
//     overriding real data.
//   - /api/oauth/usage for the actual 5-hour / 7-day windows the
//     CLI's own /status command renders.
//
// Both endpoints are reverse-engineered (see anthropics/claude-code#34348
// and codelynx.dev's "Claude Code usage limits" post). We degrade per
// row: a profile failure falls back to "couldn't read profile" with no
// fingerprint (which still uniquely identifies "this machine has
// something but we couldn't tell what"); a usage failure leaves
// fingerprint set but ships an error.
//
// Wrapped in retryOnAuthFailure: if the first attempt's HTTP call hit
// 401, we re-read the credentials file (which the CLI rewrites on
// every silent OAuth refresh) and try once more. Closes the rotation
// race documented on the helper.
func claudeCodeProbe(client *http.Client) Probe {
	return func(ctx context.Context, now time.Time) (*protocol.AgentQuota, error) {
		return retryOnAuthFailure(func() (*protocol.AgentQuota, bool, error) {
			return claudeCodeProbeOnce(ctx, client, now)
		})
	}
}

// claudeCodeProbeOnce is one attempt at the probe described on
// claudeCodeProbe. The middle return value is true iff this attempt
// returned an HTTP 401 from one of the OAuth endpoints — which is the
// signal the wrapper uses to decide whether re-reading the creds file
// and retrying might help.
func claudeCodeProbeOnce(ctx context.Context, client *http.Client, now time.Time) (*protocol.AgentQuota, bool, error) {
	creds, err := readClaudeCredentials()
	if err != nil {
		if errors.Is(err, errNoAuth) {
			return tombstone(now, "claude-code", "claude-code-oauth", "not signed in"), false, nil
		}
		return nil, false, err
	}
	token := creds.ClaudeAIOAuth.AccessToken
	if token == "" {
		return tombstone(now, "claude-code", "claude-code-oauth", "not signed in"), false, nil
	}

	baseHeaders := map[string]string{
		"Authorization":     "Bearer " + token,
		"anthropic-beta":    "oauth-2025-04-20",
		"anthropic-version": "2023-06-01",
		"User-Agent":        "argus-sidecar",
	}

	// Profile lookup is the gate: without a stable account uuid we
	// can't safely fingerprint the row, and an unfingerprinted row
	// with windows would land in the tombstone group and outrank
	// genuine tombstones from other machines on `checkedAt`. So if
	// /api/oauth/profile fails (expired token, vendor 5xx) we
	// short-circuit to a tombstone — same wire shape as "not signed
	// in" but with a more diagnostic reason. Same-machine logout
	// already produces the same kind of row, so the server's
	// per-machine cleanup handles both the same way.
	accountUUID, profileStatus, err := claudeFetchAccountUUID(ctx, client, baseHeaders)
	if err != nil {
		return tombstone(now, "claude-code", "claude-code-oauth", "couldn't read profile: "+truncate(err.Error(), 200)), profileStatus == http.StatusUnauthorized, nil
	}
	if accountUUID == "" {
		return tombstone(now, "claude-code", "claude-code-oauth", "profile returned no account uuid"), false, nil
	}
	row := &protocol.AgentQuota{
		Type:        "claude-code",
		Source:      "claude-code-oauth",
		Fingerprint: fingerprintFor("claude-code-oauth", accountUUID),
		Windows:     []protocol.QuotaWindow{},
		CheckedAt:   now.UnixMilli(),
	}

	status, body, err := httpGetJSON(ctx, client, "https://api.anthropic.com/api/oauth/usage", baseHeaders)
	if err != nil {
		row.Error = truncate(err.Error(), 240)
		return row, false, nil
	}
	if status >= 400 {
		row.Error = fmt.Sprintf("anthropic /oauth/usage %d: %s", status, truncate(string(body), 200))
		return row, status == http.StatusUnauthorized, nil
	}

	// The endpoint returns a flat object whose keys are window
	// names ("five_hour", "seven_day", "seven_day_opus", …). We
	// parse defensively: any object value with a numeric
	// "utilization" and a string "resets_at" is treated as a
	// window, so adding a new plan tier upstream doesn't require
	// a sidecar release.
	raw := map[string]any{}
	if err := unmarshal(body, &raw); err != nil {
		row.Error = "unparseable response: " + truncate(err.Error(), 200)
		return row, false, nil
	}
	for key, v := range raw {
		obj, ok := v.(map[string]any)
		if !ok {
			continue
		}
		util, ok := numberFromAny(obj["utilization"])
		if !ok {
			continue
		}
		// Inactive plan-tier windows ship with `resets_at: null` and
		// 0% utilization (e.g. `seven_day_sonnet`,
		// `seven_day_omelette` for accounts that don't have those
		// per-model limits) — drop them so the panel only shows
		// windows the user is actually being charged against. Active
		// windows with 0% used (a fresh 5-hour reset) still carry a
		// real `resets_at` and survive this filter.
		resetsAt, _ := obj["resets_at"].(string)
		if resetsAt == "" {
			continue
		}
		row.Windows = append(row.Windows, protocol.QuotaWindow{
			Key:                key,
			Label:              labelForClaudeKey(key),
			UtilizationPercent: clampPercent(util),
			ResetsAt:           resetsAt,
		})
	}
	// Stable order so the dashboard doesn't reflow rows on each
	// refresh — Go map iteration is randomized.
	sortWindows(row.Windows)
	if len(row.Windows) == 0 {
		row.Error = "no recognized windows in response"
	}
	return row, false, nil
}

// claudeFetchAccountUUID hits /api/oauth/profile and returns
// account.uuid — Anthropic's stable per-account identifier. This
// uuid does not rotate the way OAuth access/refresh tokens do, so
// it's safe to feed into a fingerprint hash and rely on it staying
// the same across token refreshes and across machines.
//
// Returns the HTTP status alongside the uuid so the caller can
// distinguish a 401 (recoverable via creds re-read + retry) from
// other failures. Status is 0 when the transport never reached the
// server (DNS / dial error).
func claudeFetchAccountUUID(ctx context.Context, client *http.Client, headers map[string]string) (string, int, error) {
	status, body, err := httpGetJSON(ctx, client, "https://api.anthropic.com/api/oauth/profile", headers)
	if err != nil {
		return "", 0, err
	}
	if status >= 400 {
		return "", status, fmt.Errorf("profile %d: %s", status, truncate(string(body), 160))
	}
	var p struct {
		Account struct {
			UUID string `json:"uuid"`
		} `json:"account"`
	}
	if err := unmarshal(body, &p); err != nil {
		return "", status, fmt.Errorf("profile unparseable: %w", err)
	}
	return p.Account.UUID, status, nil
}

type claudeCredentials struct {
	ClaudeAIOAuth struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresAt    int64  `json:"expiresAt"`
	} `json:"claudeAiOauth"`
}

func readClaudeCredentials() (*claudeCredentials, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("locate home dir: %w", err)
	}
	path := filepath.Join(home, ".claude", ".credentials.json")
	var c claudeCredentials
	if err := readJSONFile(path, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

// labelForClaudeKey maps the snake-case keys Anthropic publishes to
// the short labels the dashboard renders. Unknown keys fall through
// to a title-cased version so we don't lose data on plan-tier
// additions we haven't seen yet.
func labelForClaudeKey(key string) string {
	switch key {
	case "five_hour":
		return "5-hour"
	case "seven_day":
		return "7-day"
	case "seven_day_opus":
		return "7-day Opus"
	case "extra_usage":
		return "Extra credits"
	default:
		return key
	}
}

// numberFromAny coerces a JSON-decoded number into a float64. JSON
// decoders return numbers as float64 by default, but if a vendor ever
// hands us a string we tolerate it gracefully.
func numberFromAny(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		if f, err := strconv.ParseFloat(x, 64); err == nil {
			return f, true
		}
	}
	return 0, false
}

func clampPercent(v float64) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return int(v + 0.5)
}
