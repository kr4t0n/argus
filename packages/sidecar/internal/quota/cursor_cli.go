package quota

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// cursorProbe reads the user's cursor session from
// `~/.config/cursor/auth.json` and reconstructs the same browser-flavored
// session cookie the cursor.com dashboard uses, then calls three
// undocumented endpoints in series:
//
//  1. POST /api/auth/me                — translates the Workos id baked
//     into the cookie into the numeric user id the dashboard's data
//     endpoints actually key on. Without this we have no way to find
//     ourselves in the team-spend roster.
//  2. POST /api/dashboard/teams        — discovers which team the user
//     belongs to. We use the first one (in practice users have a single
//     team; if you're on multiple, we report on the first one returned
//     by Cursor — same default the web dashboard uses).
//  3. POST /api/dashboard/get-team-spend — returns the full member list
//     plus the current billing-cycle bounds. We pluck out the entry
//     matching our numeric id and turn its spend / limit / cycle-end
//     into a single "Monthly" QuotaWindow.
//
// All three endpoints are CSRF-gated (the server rejects requests
// without an `Origin: https://cursor.com` header), so we forge the same
// header pair the browser would send. Failure modes:
//   - No auth file → drop the row entirely (user hasn't signed in).
//   - Solo / free account (no team) → row with `error="no cursor team
//     for this account"`. Cursor's per-user spend endpoint differs in
//     that case; we don't try to detect it because the dashboard panel
//     would conflate the shapes.
//   - Vendor changes the response → `error="<endpoint> unparseable"`.
//     The dashboard renders this as "unknown" with the reason on hover.
//
// Cursor's teams are billed in dollars rather than tokens or requests,
// so the wire-level UtilizationPercent here is `overallSpendCents /
// (effectivePerUserLimitDollars * 100)` — same direction as the other
// CLIs (utilization-used, 0–100), just denominated differently. The
// dashboard renders this identically to the claude-code / codex bars.
func cursorProbe(client *http.Client) Probe {
	return func(ctx context.Context, now time.Time) (*protocol.AgentQuota, error) {
		auth, err := readCursorAuth()
		if err != nil {
			if errors.Is(err, errNoAuth) {
				return nil, nil
			}
			return nil, err
		}

		row := &protocol.AgentQuota{
			Type:      "cursor-cli",
			Source:    "cursor-workos",
			Windows:   []protocol.QuotaWindow{},
			CheckedAt: now.UnixMilli(),
		}

		myID, err := cursorFetchSelfID(ctx, client, auth.cookie)
		if err != nil {
			row.Error = truncate(err.Error(), 240)
			return row, nil
		}

		teamID, ok, err := cursorFetchFirstTeamID(ctx, client, auth.cookie)
		if err != nil {
			row.Error = truncate(err.Error(), 240)
			return row, nil
		}
		if !ok {
			row.Error = "no cursor team for this account"
			return row, nil
		}

		win, err := cursorFetchSpendWindow(ctx, client, auth.cookie, teamID, myID)
		if err != nil {
			row.Error = truncate(err.Error(), 240)
			return row, nil
		}
		row.Windows = append(row.Windows, win)
		return row, nil
	}
}

type cursorAuthRecord struct {
	workosID    string
	accessToken string
	cookie      string
}

func readCursorAuth() (*cursorAuthRecord, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("locate home dir: %w", err)
	}
	path := filepath.Join(home, ".config", "cursor", "auth.json")
	var raw map[string]any
	if err := readJSONFile(path, &raw); err != nil {
		return nil, err
	}
	token, _ := raw["accessToken"].(string)
	if token == "" {
		return nil, errNoAuth
	}
	workosID, err := workosIDFromJWT(token)
	if err != nil {
		return nil, err
	}
	// The cookie's separator between user id and token is a literal
	// `::`, but Cursor's middleware accepts (and the official dashboard
	// sends) the URL-encoded form `%3A%3A`. We mirror that — sending
	// the raw `::` works at time of writing but is the form most
	// likely to break first if they tighten validation.
	cookie := "WorkosCursorSessionToken=" + workosID + "%3A%3A" + token
	return &cursorAuthRecord{
		workosID:    workosID,
		accessToken: token,
		cookie:      cookie,
	}, nil
}

// workosIDFromJWT decodes the middle (claims) segment of the cursor
// session JWT and returns the workos user id baked into the `sub`
// claim. The claim is shaped `auth0|user_<id>`; we strip the auth0
// prefix because the cookie wants only the workos id portion.
func workosIDFromJWT(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return "", fmt.Errorf("malformed JWT")
	}
	payload := parts[1]
	if pad := len(payload) % 4; pad != 0 {
		payload += strings.Repeat("=", 4-pad)
	}
	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		// Some cursor tokens have been observed without padding even
		// after the % 4 fix above; try the no-pad variant before giving
		// up so we don't reject otherwise-valid tokens.
		decoded, err = base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			return "", fmt.Errorf("decode JWT payload: %w", err)
		}
	}
	var claims struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return "", fmt.Errorf("parse JWT claims: %w", err)
	}
	sub := claims.Sub
	if i := strings.IndexRune(sub, '|'); i >= 0 {
		sub = sub[i+1:]
	}
	if sub == "" {
		return "", fmt.Errorf("JWT has empty sub claim")
	}
	return sub, nil
}

// cursorPost wraps the shared httpPostJSON helper with the headers
// Cursor's CSRF middleware demands. Returns an error verbatim from the
// transport, or a synthesized error carrying the (truncated) upstream
// body for any non-2xx status.
func cursorPost(ctx context.Context, client *http.Client, cookie, path string, body []byte) ([]byte, error) {
	rawURL := "https://cursor.com" + path
	status, b, err := httpPostJSON(ctx, client, rawURL, body, map[string]string{
		"Cookie":     cookie,
		"Origin":     "https://cursor.com",
		"Referer":    "https://cursor.com/dashboard",
		"User-Agent": "argus-sidecar",
	})
	if err != nil {
		return nil, err
	}
	if status >= 400 {
		return nil, fmt.Errorf("cursor %s %d: %s", path, status, truncate(string(b), 200))
	}
	return b, nil
}

func cursorFetchSelfID(ctx context.Context, client *http.Client, cookie string) (int64, error) {
	body, err := cursorPost(ctx, client, cookie, "/api/auth/me", []byte("{}"))
	if err != nil {
		return 0, err
	}
	var me struct {
		ID    int64  `json:"id"`
		Email string `json:"email"`
	}
	if err := json.Unmarshal(body, &me); err != nil {
		return 0, fmt.Errorf("auth/me unparseable: %w", err)
	}
	if me.ID == 0 {
		return 0, fmt.Errorf("auth/me did not return numeric id")
	}
	return me.ID, nil
}

func cursorFetchFirstTeamID(ctx context.Context, client *http.Client, cookie string) (int64, bool, error) {
	body, err := cursorPost(ctx, client, cookie, "/api/dashboard/teams", []byte("{}"))
	if err != nil {
		return 0, false, err
	}
	var teams struct {
		Teams []struct {
			ID int64 `json:"id"`
		} `json:"teams"`
	}
	if err := json.Unmarshal(body, &teams); err != nil {
		return 0, false, fmt.Errorf("teams unparseable: %w", err)
	}
	if len(teams.Teams) == 0 {
		return 0, false, nil
	}
	return teams.Teams[0].ID, true, nil
}

func cursorFetchSpendWindow(ctx context.Context, client *http.Client, cookie string, teamID, userID int64) (protocol.QuotaWindow, error) {
	req, _ := json.Marshal(map[string]any{"teamId": teamID})
	body, err := cursorPost(ctx, client, cookie, "/api/dashboard/get-team-spend", req)
	if err != nil {
		return protocol.QuotaWindow{}, err
	}
	var spend struct {
		TeamMemberSpend        []map[string]any `json:"teamMemberSpend"`
		SubscriptionCycleStart string           `json:"subscriptionCycleStart"`
		NextCycleStart         string           `json:"nextCycleStart"`
	}
	if err := json.Unmarshal(body, &spend); err != nil {
		return protocol.QuotaWindow{}, fmt.Errorf("team-spend unparseable: %w", err)
	}

	var self map[string]any
	for _, m := range spend.TeamMemberSpend {
		if id, ok := numberFromAny(m["userId"]); ok && int64(id) == userID {
			self = m
			break
		}
	}
	if self == nil {
		return protocol.QuotaWindow{}, fmt.Errorf("self not found in team-spend roster")
	}

	// Prefer overallSpendCents when present (matches the dashboard's
	// "Spend" column, which counts everything including premium
	// features); fall back to spendCents on older shapes.
	spendCents, ok := numberFromAny(self["overallSpendCents"])
	if !ok {
		spendCents, _ = numberFromAny(self["spendCents"])
	}
	limitDollars, ok := numberFromAny(self["effectivePerUserLimitDollars"])
	if !ok || limitDollars == 0 {
		limitDollars, _ = numberFromAny(self["monthlyLimitDollars"])
	}
	if limitDollars == 0 {
		return protocol.QuotaWindow{}, fmt.Errorf("no spend limit configured for this user (admin contract?)")
	}
	utilization := spendCents / (limitDollars * 100) * 100

	resetsAt := ""
	// Cycle bounds come back as strings holding millisecond epochs;
	// convert through our generic number coercer in case Cursor ever
	// switches them to numbers.
	if ms, ok := parseStringMillis(spend.NextCycleStart); ok && ms > 0 {
		resetsAt = time.UnixMilli(ms).UTC().Format(time.RFC3339)
	}

	return protocol.QuotaWindow{
		Key:                "monthly",
		Label:              "Monthly",
		UtilizationPercent: clampPercent(utilization),
		ResetsAt:           resetsAt,
	}, nil
}

func parseStringMillis(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}
