package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// codexProbe reads the user's Codex auth file and calls the same
// /backend-api/wham/usage endpoint the CLI's own /status command uses
// (see openai/codex#10869, openai/codex#15281, and the knightli.com
// "codex-quota" guide). Only the ChatGPT-mode auth path is supported:
// the api-key path doesn't have a public endpoint that exposes
// remaining quota, so we drop the row in that case rather than
// surface a permanent "unknown" error.
//
// The ChatGPT endpoint reports `percent_left`; we flip it to
// utilization-used so the wire stays uniform with claude-code's
// `utilization` semantics.
func codexProbe(client *http.Client) Probe {
	return func(ctx context.Context, now time.Time) (*protocol.AgentQuota, error) {
		auth, err := readCodexAuth()
		if err != nil {
			if errors.Is(err, errNoAuth) {
				return tombstone(now, "codex", "codex-chatgpt", "not signed in"), nil
			}
			return nil, err
		}
		// API-key codex hits the OpenAI Platform API; that path has no
		// public usage endpoint the CLI uses, so we can't produce a
		// real row. Tombstone with a specific reason so the dashboard
		// explains why the panel is empty *and* a prior chatgpt-mode
		// row gets cleared if the user just toggled modes.
		if auth.AuthMode != "chatgpt" {
			return tombstone(now, "codex", "codex-chatgpt", "Codex is in API-key mode (no plan-quota endpoint)"), nil
		}
		token := auth.Tokens.AccessToken
		accountID := auth.Tokens.AccountID
		if token == "" || accountID == "" {
			return tombstone(now, "codex", "codex-chatgpt", "not signed in"), nil
		}

		row := &protocol.AgentQuota{
			Type:        "codex",
			Source:      "codex-chatgpt",
			Fingerprint: fingerprintFor("codex-chatgpt", accountID),
			Windows:     []protocol.QuotaWindow{},
			CheckedAt:   now.UnixMilli(),
		}

		status, body, err := httpGetJSON(ctx, client, "https://chatgpt.com/backend-api/wham/usage", map[string]string{
			"Authorization":      "Bearer " + token,
			"ChatGPT-Account-Id": accountID,
			"Origin":             "https://chatgpt.com",
			"Referer":            "https://chatgpt.com/",
			"User-Agent":         "argus-sidecar",
		})
		if err != nil {
			row.Error = truncate(err.Error(), 240)
			return row, nil
		}
		if status >= 400 {
			row.Error = fmt.Sprintf("chatgpt /wham/usage %d: %s", status, truncate(string(body), 200))
			return row, nil
		}

		windows, err := parseChatGPTUsage(body)
		if err != nil {
			row.Error = "unparseable response: " + truncate(err.Error(), 200)
			return row, nil
		}
		row.Windows = windows
		if len(windows) == 0 {
			row.Error = "no recognized windows in response"
		}
		return row, nil
	}
}

type codexAuth struct {
	AuthMode string `json:"auth_mode"`
	Tokens   struct {
		IDToken      string `json:"id_token"`
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		AccountID    string `json:"account_id"`
	} `json:"tokens"`
}

func readCodexAuth() (*codexAuth, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("locate home dir: %w", err)
	}
	path := filepath.Join(home, ".codex", "auth.json")
	var a codexAuth
	if err := readJSONFile(path, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// parseChatGPTUsage normalizes the shape ChatGPT's /backend-api/wham/usage
// returns. As of writing (validated against a Pro Lite account in May
// 2026), the response looks like:
//
//	{
//	  "rate_limit": {
//	    "allowed": true, "limit_reached": false,
//	    "primary_window":   { "used_percent": 12, "limit_window_seconds": 18000,  "reset_at": 1778243769 },
//	    "secondary_window": { "used_percent":  5, "limit_window_seconds": 604800, "reset_at": 1778637465 },
//	    ...
//	  },
//	  "additional_rate_limits": [ ... per-feature limits ... ],
//	  ...
//	}
//
// We also tolerate the `rate_limits` (plural) / `percent_left` /
// `remaining_percent` / `reset_time_ms` flavors community projects
// documented earlier — same parser, same output shape — so a
// future tweak on OpenAI's side doesn't black out the panel.
//
// Unknown shapes return an empty slice + nil error; the caller turns
// that into a "no recognized windows" message.
func parseChatGPTUsage(body []byte) ([]protocol.QuotaWindow, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	limitObj := pickRateLimitObject(raw)
	if limitObj == nil {
		// Some flavors put the windows at the top level. Fall back
		// to that before giving up.
		limitObj = raw
	}

	out := []protocol.QuotaWindow{}
	for key, v := range limitObj {
		obj, ok := v.(map[string]any)
		if !ok {
			continue
		}
		w, ok := chatgptWindowFrom(key, obj)
		if !ok {
			continue
		}
		out = append(out, w)
	}
	sortWindows(out)
	return out, nil
}

func pickRateLimitObject(raw map[string]any) map[string]any {
	for _, k := range []string{"rate_limit", "rate_limits"} {
		if obj, ok := raw[k].(map[string]any); ok {
			return obj
		}
	}
	return nil
}

// chatgptWindowFrom picks one window's QuotaWindow out of one object
// in the response. Recognizes `percent_left` / `remaining_percent` /
// `utilization`, and either `reset_time_ms` (epoch millis) or
// `reset_at` (ISO 8601). Returns false if neither shape matches.
func chatgptWindowFrom(key string, obj map[string]any) (protocol.QuotaWindow, bool) {
	utilization, ok := chatgptUtilization(obj)
	if !ok {
		return protocol.QuotaWindow{}, false
	}
	resetsAt := chatgptResetsAt(obj)
	canonicalKey, label := normalizeCodexWindow(key, obj)
	return protocol.QuotaWindow{
		Key:                canonicalKey,
		Label:              label,
		UtilizationPercent: clampPercent(utilization),
		ResetsAt:           resetsAt,
	}, true
}

func chatgptUtilization(obj map[string]any) (float64, bool) {
	// Current shape (May 2026): `used_percent` is the canonical field
	// and it's already in the "utilization-used" direction we publish.
	if v, ok := numberFromAny(obj["used_percent"]); ok {
		return v, true
	}
	// Older shapes some community probes documented — kept so an OpenAI
	// rollback doesn't blank our panel.
	if v, ok := numberFromAny(obj["percent_left"]); ok {
		return 100 - v, true
	}
	if v, ok := numberFromAny(obj["remaining_percent"]); ok {
		return 100 - v, true
	}
	if v, ok := numberFromAny(obj["utilization"]); ok {
		return v, true
	}
	return 0, false
}

func chatgptResetsAt(obj map[string]any) string {
	if s, ok := obj["reset_at"].(string); ok && s != "" {
		return s
	}
	// Current shape: `reset_at` is an epoch number in seconds (10 digits
	// for the foreseeable future). We heuristic by magnitude in case
	// OpenAI ever switches to ms — anything past ~year-33658 (10^12 s)
	// is overwhelmingly more likely to be a millisecond timestamp than
	// a real second one.
	if n, ok := numberFromAny(obj["reset_at"]); ok && n > 0 {
		return epochNumberToRFC3339(n)
	}
	if ms, ok := numberFromAny(obj["reset_time_ms"]); ok && ms > 0 {
		return time.UnixMilli(int64(ms)).UTC().Format(time.RFC3339)
	}
	if secs, ok := numberFromAny(obj["reset_time_seconds"]); ok && secs > 0 {
		return time.Unix(int64(secs), 0).UTC().Format(time.RFC3339)
	}
	return ""
}

func epochNumberToRFC3339(n float64) string {
	const msThreshold = 1e12 // ~year 33658 in seconds; anything bigger is millis
	if n >= msThreshold {
		return time.UnixMilli(int64(n)).UTC().Format(time.RFC3339)
	}
	return time.Unix(int64(n), 0).UTC().Format(time.RFC3339)
}

// normalizeCodexWindow maps the field name we found the window under
// (or, for primary/secondary, the `limit_window_seconds` value) to the
// canonical "five_hour"/"weekly" keys we render in the dashboard.
// Unknown keys fall through unchanged so we don't lose data when
// OpenAI adds a tier.
func normalizeCodexWindow(rawKey string, obj map[string]any) (string, string) {
	if rawKey == "primary_window" || rawKey == "secondary_window" {
		// The primary/secondary nesting hides which window is which;
		// `limit_window_seconds` disambiguates. 5h ≈ 18000, week ≈ 604800.
		if secs, ok := numberFromAny(obj["limit_window_seconds"]); ok {
			switch {
			case secs <= 6*3600:
				return "five_hour", "5-hour"
			case secs >= 24*3600:
				return "weekly", "7-day"
			}
		}
		// Fall back to the raw key — the dashboard will render it as
		// "primary_window" rather than silently dropping it.
		return rawKey, rawKey
	}
	switch rawKey {
	case "five_hour":
		return "five_hour", "5-hour"
	case "weekly":
		return "weekly", "7-day"
	}
	return rawKey, rawKey
}

// sortWindows orders windows shortest-cycle first so the dashboard
// renders 5-hour above 7-day above weekly etc. Anything we don't have
// an explicit rank for sorts after the known set, alphabetically, so
// ordering stays deterministic across refreshes (map iteration is
// randomized otherwise).
func sortWindows(ws []protocol.QuotaWindow) {
	rank := map[string]int{
		"five_hour":      1,
		"seven_day":      2,
		"seven_day_opus": 3,
		"weekly":         4,
		"extra_usage":    5,
	}
	sort.SliceStable(ws, func(i, j int) bool {
		ri, oki := rank[ws[i].Key]
		rj, okj := rank[ws[j].Key]
		switch {
		case oki && okj:
			return ri < rj
		case oki:
			return true
		case okj:
			return false
		}
		return ws[i].Key < ws[j].Key
	})
}

// unmarshal is a thin wrapper over json.Unmarshal that captures the
// Anthropic claude-code probe path's needs in one call. Kept here
// rather than next to the claude probe so we can reuse it if/when we
// add cursor-cli.
func unmarshal(body []byte, dst any) error {
	return json.Unmarshal(body, dst)
}
