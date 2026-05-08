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
// calls the same /api/oauth/usage endpoint the CLI's own /status
// command uses. The endpoint is undocumented — community-reverse-
// engineered (see the codelynx.dev "Claude Code usage limits" post and
// anthropics/claude-code#34348) — so the probe degrades gracefully if
// Anthropic changes the response shape.
//
// Returns (nil, nil) when ~/.claude/.credentials.json is absent: the
// user has never logged in, so there's no row to render.
func claudeCodeProbe(client *http.Client) Probe {
	return func(ctx context.Context, now time.Time) (*protocol.AgentQuota, error) {
		creds, err := readClaudeCredentials()
		if err != nil {
			if errors.Is(err, errNoAuth) {
				return nil, nil
			}
			return nil, err
		}
		token := creds.ClaudeAIOAuth.AccessToken
		if token == "" {
			// File present but empty `accessToken`. Treat as "no auth"
			// rather than fabricating a quota row; any prior session
			// will have failed too.
			return nil, nil
		}

		row := &protocol.AgentQuota{
			Type:      "claude-code",
			Source:    "claude-code-oauth",
			Windows:   []protocol.QuotaWindow{},
			CheckedAt: now.UnixMilli(),
		}

		status, body, err := httpGetJSON(ctx, client, "https://api.anthropic.com/api/oauth/usage", map[string]string{
			"Authorization":   "Bearer " + token,
			"anthropic-beta":  "oauth-2025-04-20",
			// Match the version the official CLI sends so we look
			// indistinguishable in vendor logs.
			"anthropic-version": "2023-06-01",
			"User-Agent":        "argus-sidecar",
		})
		if err != nil {
			row.Error = truncate(err.Error(), 240)
			return row, nil
		}
		if status >= 400 {
			row.Error = fmt.Sprintf("anthropic /oauth/usage %d: %s", status, truncate(string(body), 200))
			return row, nil
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
			return row, nil
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
			resetsAt, _ := obj["resets_at"].(string)
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
		return row, nil
	}
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
