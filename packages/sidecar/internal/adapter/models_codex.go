package adapter

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// codex ships a machine-readable catalog behind `codex debug models`
// (verified against codex-cli 0.135.0). Each entry carries the slug,
// display metadata, per-model reasoning levels + default, the context
// window, and any extra speed tiers — everything the picker needs.
//
// Caveat: the command lives under `debug`, so it isn't a stability
// contract. We parse defensively (unknown fields ignored, missing
// fields degrade to absent facets) and any hard failure surfaces as a
// catalog error, which the dashboard renders as the free-text
// fallback rather than a broken picker.

type codexCatalogModel struct {
	Slug                     string   `json:"slug"`
	DisplayName              string   `json:"display_name"`
	Description              string   `json:"description"`
	DefaultReasoningLevel    string   `json:"default_reasoning_level"`
	SupportedReasoningLevels []struct {
		Effort string `json:"effort"`
	} `json:"supported_reasoning_levels"`
	Visibility           string   `json:"visibility"`
	ContextWindow        int64    `json:"context_window"`
	AdditionalSpeedTiers []string `json:"additional_speed_tiers"`
}

type codexCatalog struct {
	Models []codexCatalogModel `json:"models"`
}

// ListModels implements ModelLister by shelling out to
// `codex debug models` and mapping the visible entries.
func (a *CodexAdapter) ListModels(ctx context.Context) ([]protocol.ModelCatalogEntry, string, error) {
	out, err := exec.CommandContext(ctx, a.binary, "debug", "models").Output()
	if err != nil {
		return nil, "", fmt.Errorf("codex debug models: %w", err)
	}
	models, err := parseCodexCatalog(out)
	if err != nil {
		return nil, "", err
	}
	return models, "cli", nil
}

func parseCodexCatalog(raw []byte) ([]protocol.ModelCatalogEntry, error) {
	var cat codexCatalog
	if err := json.Unmarshal(raw, &cat); err != nil {
		return nil, fmt.Errorf("parse codex catalog: %w", err)
	}
	out := make([]protocol.ModelCatalogEntry, 0, len(cat.Models))
	for _, m := range cat.Models {
		// "hide" entries are internal (e.g. codex-auto-review) — not
		// user-selectable in codex's own picker either.
		if m.Visibility != "list" {
			continue
		}
		entry := protocol.ModelCatalogEntry{
			ID:            m.Slug,
			DisplayName:   m.DisplayName,
			Description:   m.Description,
			ContextWindow: m.ContextWindow,
		}
		facets := &protocol.ModelCatalogFacets{}
		if len(m.SupportedReasoningLevels) > 0 {
			levels := make([]string, 0, len(m.SupportedReasoningLevels))
			for _, l := range m.SupportedReasoningLevels {
				if l.Effort != "" {
					levels = append(levels, l.Effort)
				}
			}
			if len(levels) > 0 {
				def := m.DefaultReasoningLevel
				if def == "" {
					def = levels[0]
				}
				facets.Effort = &protocol.ModelEffortFacet{Levels: levels, Default: def}
			}
		}
		for _, tier := range m.AdditionalSpeedTiers {
			if tier == "fast" {
				facets.Speed = &protocol.ModelSpeedFacet{Options: []string{"standard", "fast"}}
				break
			}
		}
		if facets.Effort != nil || facets.Speed != nil {
			entry.Facets = facets
		}
		out = append(out, entry)
	}
	return out, nil
}
