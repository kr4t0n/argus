package adapter

import (
	"testing"
)

// Trimmed real output of `codex debug models` (codex-cli 0.135.0).
const codexCatalogFixture = `{"models":[
  {"slug":"gpt-5.5","display_name":"GPT-5.5","description":"Frontier model.",
   "default_reasoning_level":"medium",
   "supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"}],
   "visibility":"list","context_window":272000,"additional_speed_tiers":["fast"]},
  {"slug":"gpt-5.3-codex-spark","display_name":"GPT-5.3-Codex-Spark","description":"Fast coding model.",
   "default_reasoning_level":"high",
   "supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"}],
   "visibility":"list","context_window":272000,"additional_speed_tiers":[]},
  {"slug":"codex-auto-review","display_name":"Codex Auto Review",
   "default_reasoning_level":"medium",
   "supported_reasoning_levels":[{"effort":"medium"}],
   "visibility":"hide","context_window":272000,"additional_speed_tiers":[]}
]}`

func TestParseCodexCatalog(t *testing.T) {
	models, err := parseCodexCatalog([]byte(codexCatalogFixture))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("want 2 visible models (hide filtered), got %d: %+v", len(models), models)
	}

	m := models[0]
	if m.ID != "gpt-5.5" || m.DisplayName != "GPT-5.5" {
		t.Fatalf("identity mismatch: %+v", m)
	}
	if m.ContextWindow != 272000 {
		t.Fatalf("context window: got %d", m.ContextWindow)
	}
	if m.Facets == nil || m.Facets.Effort == nil {
		t.Fatalf("missing effort facet: %+v", m)
	}
	if m.Facets.Effort.Default != "medium" || len(m.Facets.Effort.Levels) != 4 {
		t.Fatalf("effort facet mismatch: %+v", m.Facets.Effort)
	}
	if m.Facets.Speed == nil {
		t.Fatalf("gpt-5.5 should declare the fast speed facet")
	}
	if models[1].Facets.Speed != nil {
		t.Fatalf("spark has no fast tier, facet should be absent")
	}
	if models[1].Facets.Effort.Default != "high" {
		t.Fatalf("spark default effort: %+v", models[1].Facets.Effort)
	}
}

// Real lines from `cursor-agent models` (2026.06.04), chosen to cover
// the parsing traps: max-as-model-name, flipped thinking/effort order
// across generations, extra-high, annotations, singletons.
const cursorCatalogFixture = `Available models

auto - Auto
gpt-5.1-codex-max-low - Codex 5.1 Max Low
gpt-5.1-codex-max-medium - Codex 5.1 Max
gpt-5.1-codex-max-xhigh - Codex 5.1 Max Extra High
composer-2.5 - Composer 2.5 (current)
composer-2.5-fast - Composer 2.5 Fast (default)
claude-fable-5-high - Fable 5 1M (NO ZDR)
claude-fable-5-thinking-max - Fable 5 1M Max Thinking (NO ZDR)
claude-opus-4-8-high - Opus 4.8 1M
claude-opus-4-8-thinking-xhigh-fast - Opus 4.8 1M Extra High Thinking Fast
gpt-5.5-medium - GPT-5.5 1M
gpt-5.5-extra-high - GPT-5.5 1M Extra High
gpt-5.5-high-fast - GPT-5.5 High Fast
claude-4.6-opus-high - Opus 4.6 1M
claude-4.6-opus-high-thinking - Opus 4.6 1M Thinking
kimi-k2.5 - Kimi K2.5

Tip: use --model <id> (or /model <id> in interactive mode) to switch.`

func TestParseCursorCatalog(t *testing.T) {
	models := parseCursorCatalog(cursorCatalogFixture)
	byID := map[string]int{}
	for i, m := range models {
		byID[m.ID] = i
	}
	if len(models) != 16 {
		t.Fatalf("want 16 entries, got %d", len(models))
	}

	get := func(id string) (m int) {
		i, ok := byID[id]
		if !ok {
			t.Fatalf("missing entry %q; have %v", id, byID)
		}
		return i
	}

	// max-as-model-name: the one-effort rule keeps Codex 5.1 Max its
	// own family instead of merging into a bogus "Codex 5.1".
	codexMax := models[get("gpt-5.1-codex-max-low")]
	if codexMax.Family != "Codex 5.1 Max" {
		t.Fatalf("codex-max family: got %q", codexMax.Family)
	}
	if codexMax.VariantLabel != "Low" {
		t.Fatalf("codex-max variant: got %q", codexMax.VariantLabel)
	}
	if v := models[get("gpt-5.1-codex-max-medium")].VariantLabel; v != "Standard" {
		t.Fatalf("family-label member variant: got %q", v)
	}

	// Flipped token order across generations lands in the right family
	// either way.
	if f := models[get("claude-opus-4-8-thinking-xhigh-fast")].Family; f != "Opus 4.8 1M" {
		t.Fatalf("opus 4.8 family: got %q", f)
	}
	if f := models[get("claude-4.6-opus-high-thinking")].Family; f != "Opus 4.6 1M" {
		t.Fatalf("opus 4.6 family: got %q", f)
	}

	// extra-high consumes both segments.
	if f := models[get("gpt-5.5-extra-high")].Family; f != "GPT-5.5 1M" {
		t.Fatalf("gpt-5.5 family: got %q", f)
	}
	// Non-1M sibling stays in the same family (variant carries the rest).
	if f := models[get("gpt-5.5-high-fast")].Family; f != "GPT-5.5 1M" {
		t.Fatalf("gpt-5.5 fast family: got %q", f)
	}

	// Annotations: default flag, NO ZDR note, (current) dropped.
	if !models[get("composer-2.5-fast")].IsDefault {
		t.Fatalf("composer-2.5-fast should be the default")
	}
	if d := models[get("composer-2.5")].DisplayName; d != "Composer 2.5" {
		t.Fatalf("(current) not stripped: %q", d)
	}
	fable := models[get("claude-fable-5-high")]
	if fable.Description != "NO ZDR" {
		t.Fatalf("fable description: got %q", fable.Description)
	}
	if fable.ContextWindow != 1_000_000 {
		t.Fatalf("fable context window: got %d", fable.ContextWindow)
	}

	// Singletons stay flat — no family, no variant.
	for _, id := range []string{"auto", "kimi-k2.5"} {
		m := models[get(id)]
		if m.Family != "" || m.VariantLabel != "" {
			t.Fatalf("%s should be flat, got family=%q variant=%q", id, m.Family, m.VariantLabel)
		}
	}
}

func TestClaudeStaticCatalog(t *testing.T) {
	a := &ClaudeCodeAdapter{}
	models, source, err := a.ListModels(t.Context())
	if err != nil || source != "static" {
		t.Fatalf("ListModels: source=%q err=%v", source, err)
	}
	ids := map[string]bool{}
	for _, m := range models {
		ids[m.ID] = true
	}
	for _, want := range []string{"fable", "opus", "sonnet", "haiku", "opusplan"} {
		if !ids[want] {
			t.Fatalf("missing alias %q in static catalog", want)
		}
	}
	for _, m := range models {
		switch m.ID {
		case "opus", "sonnet":
			if m.Facets == nil || m.Facets.Context == nil {
				t.Fatalf("%s must declare the 1m context facet", m.ID)
			}
		case "haiku":
			if m.Facets != nil {
				t.Fatalf("haiku must declare no facets")
			}
		}
	}
}
