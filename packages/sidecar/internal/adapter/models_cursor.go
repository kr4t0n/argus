package adapter

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// cursor-agent's catalog is `cursor-agent models` — plain text, one
// `<slug> - <Display Name>` line per model, already filtered to what
// this account's plan can run (verified against cursor-agent
// 2026.06.04). Every selection dimension (effort, thinking, fast tier,
// context window) is encoded in the slug, so entries carry no facets.
//
// To keep a ~110-entry flat list usable, we GROUP entries into
// families (Family + VariantLabel) so the picker can render a
// two-level model → variant dropdown. Grouping is labeling only: the
// dispatched value is always the exact slug from the CLI's list, never
// a recomposed one, so a mis-grouped entry is a cosmetic bug, not a
// dispatch failure.
//
// Slug grammar is irregular across generations (token order flips:
// `claude-opus-4-8-thinking-high` vs `claude-4.6-opus-high-thinking`;
// `max` is an effort suffix on `claude-fable-5-max` but part of the
// model name in `gpt-5.1-codex-max-low`). The family derivation below
// strips variant segments right-to-left and consumes AT MOST ONE
// effort token — that single rule disambiguates every observed case:
// once `low` is stripped from `gpt-5.1-codex-max-low`, the `max`
// before it is protected.

// ListModels implements ModelLister by shelling out to
// `cursor-agent models` and parsing the line-oriented output.
func (a *CursorCLIAdapter) ListModels(ctx context.Context) ([]protocol.ModelCatalogEntry, string, error) {
	out, err := exec.CommandContext(ctx, a.binary, "models").Output()
	if err != nil {
		return nil, "", fmt.Errorf("cursor-agent models: %w", err)
	}
	models := parseCursorCatalog(string(out))
	if len(models) == 0 {
		return nil, "", fmt.Errorf("cursor-agent models: no models parsed (not logged in?)")
	}
	return models, "cli", nil
}

func parseCursorCatalog(raw string) []protocol.ModelCatalogEntry {
	type parsed struct {
		entry      protocol.ModelCatalogEntry
		display    string // annotation-free display name
		familySlug string
	}
	var rows []parsed

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		// Data lines are `<slug> - <Display Name>`; everything else
		// (header, blank lines, the trailing "Tip:" hint) is skipped.
		slug, display, ok := strings.Cut(line, " - ")
		if !ok || slug == "" || strings.ContainsAny(slug, " \t") {
			continue
		}
		display, isDefault, note := cursorStripAnnotations(display)
		e := protocol.ModelCatalogEntry{
			ID:          slug,
			DisplayName: display,
			Description: note,
			IsDefault:   isDefault,
		}
		if cursorDisplayHasWord(display, "1M") {
			e.ContextWindow = 1_000_000
		}
		rows = append(rows, parsed{entry: e, display: display, familySlug: cursorFamilySlug(slug)})
	}

	// Family label = shortest member display name. Only families with
	// 2+ members get Family/VariantLabel — singletons stay flat.
	size := map[string]int{}
	label := map[string]string{}
	for _, r := range rows {
		size[r.familySlug]++
		if cur, ok := label[r.familySlug]; !ok || len(r.display) < len(cur) {
			label[r.familySlug] = r.display
		}
	}

	out := make([]protocol.ModelCatalogEntry, 0, len(rows))
	for _, r := range rows {
		e := r.entry
		if size[r.familySlug] > 1 {
			e.Family = label[r.familySlug]
			e.VariantLabel = cursorVariantLabel(r.display, e.Family)
		}
		out = append(out, e)
	}
	return out
}

// cursorStripAnnotations removes trailing parenthesized notes from a
// display name: "(default)" marks the CLI default, "(current)" is
// dropped, anything else ("NO ZDR") is surfaced as the description.
func cursorStripAnnotations(display string) (clean string, isDefault bool, note string) {
	clean = strings.TrimSpace(display)
	for {
		open := strings.LastIndex(clean, "(")
		if open < 0 || !strings.HasSuffix(clean, ")") {
			return clean, isDefault, note
		}
		inner := clean[open+1 : len(clean)-1]
		switch strings.ToLower(inner) {
		case "default":
			isDefault = true
		case "current":
			// informational; the picker's Default entry covers it
		default:
			note = inner
		}
		clean = strings.TrimSpace(clean[:open])
	}
}

// cursorFamilySlug strips variant segments off a slug right-to-left:
// any number of `fast` / `thinking` segments, plus AT MOST ONE effort
// token (`none|minimal|low|medium|high|xhigh|max`, where `extra-high`
// counts as one token across two segments). The one-effort rule is
// what protects `max` when it's part of the model name — see the file
// comment.
func cursorFamilySlug(slug string) string {
	segs := strings.Split(slug, "-")
	end := len(segs)
	effortSeen := false
	for end > 1 {
		s := segs[end-1]
		switch {
		case s == "fast" || s == "thinking":
			end--
		case !effortSeen && cursorIsEffortSegment(s):
			effortSeen = true
			end--
			if s == "high" && end > 1 && segs[end-1] == "extra" {
				end--
			}
		default:
			return strings.Join(segs[:end], "-")
		}
	}
	return strings.Join(segs[:end], "-")
}

func cursorIsEffortSegment(s string) bool {
	switch s {
	case "none", "minimal", "low", "medium", "high", "xhigh", "max":
		return true
	}
	return false
}

// cursorVariantLabel is the display name minus the words it shares
// with the family label, e.g. ("Opus 4.8 1M Extra High Thinking",
// "Opus 4.8 1M") → "Extra High Thinking". Empty remainder (the family
// label itself) renders as "Standard".
func cursorVariantLabel(display, family string) string {
	dw := strings.Fields(display)
	fw := strings.Fields(family)
	i := 0
	for i < len(dw) && i < len(fw) && dw[i] == fw[i] {
		i++
	}
	rest := strings.Join(dw[i:], " ")
	if rest == "" {
		return "Standard"
	}
	return rest
}

func cursorDisplayHasWord(display, word string) bool {
	for _, w := range strings.Fields(display) {
		if w == word {
			return true
		}
	}
	return false
}
