package adapter

import (
	"context"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// Claude Code has no CLI surface for listing models (no `models`
// subcommand; the stream-json control protocol rejects supported_models
// and friends — verified against claude 2.1.170), so its catalog is a
// compiled-in table of the documented aliases.
//
// This is safe to ship statically because the aliases are stability
// contracts on the CLI's side: `opus` / `sonnet` / `haiku` / `fable`
// track the latest model for the user's provider, and `--effort` falls
// back gracefully (an unsupported level runs as the highest supported
// level at or below it). The facet declarations below describe the
// CURRENT latest models per docs — re-check
// https://code.claude.com/docs/en/model-config when bumping.
//
// The `[1m]` context facet is plan/account-gated (e.g. sonnet[1m]
// needs usage credits) and can't be probed up front; selecting it on
// an unentitled account surfaces as a turn error, which is the
// designed degradation path.

// claudeEffort returns the effort facet for a claude model tier.
func claudeEffort(levels ...string) *protocol.ModelEffortFacet {
	return &protocol.ModelEffortFacet{Levels: levels, Default: "high"}
}

var claudeContextFacet = &protocol.ModelContextFacet{Options: []string{"default", "1m"}}

var claudeModelCatalog = []protocol.ModelCatalogEntry{
	{
		ID:          "fable",
		DisplayName: "Fable 5",
		Description: "Most capable; long autonomous sessions. Always runs with 1M context.",
		ContextWindow: 1_000_000,
		Facets: &protocol.ModelCatalogFacets{
			Effort: claudeEffort("low", "medium", "high", "xhigh", "max"),
		},
	},
	{
		ID:          "opus",
		DisplayName: "Opus",
		Description: "Latest Opus — complex reasoning tasks.",
		Facets: &protocol.ModelCatalogFacets{
			Effort:  claudeEffort("low", "medium", "high", "xhigh", "max"),
			Context: claudeContextFacet,
		},
	},
	{
		ID:          "sonnet",
		DisplayName: "Sonnet",
		Description: "Latest Sonnet — daily coding tasks.",
		Facets: &protocol.ModelCatalogFacets{
			// Sonnet 4.6 has no xhigh; claude falls back to high if a
			// stale picker sends it anyway.
			Effort:  claudeEffort("low", "medium", "high", "max"),
			Context: claudeContextFacet,
		},
	},
	{
		ID:          "haiku",
		DisplayName: "Haiku",
		Description: "Fast and efficient — simple tasks. No effort control.",
	},
	{
		ID:          "opusplan",
		DisplayName: "Opus Plan",
		Description: "Opus in plan mode, Sonnet for execution. Plan phase capped at 200K.",
		Facets: &protocol.ModelCatalogFacets{
			Effort: claudeEffort("low", "medium", "high", "xhigh", "max"),
		},
	},
}

// ListModels implements ModelLister with the static alias table.
func (a *ClaudeCodeAdapter) ListModels(_ context.Context) ([]protocol.ModelCatalogEntry, string, error) {
	// Copy so callers can't mutate the package-level table.
	out := make([]protocol.ModelCatalogEntry, len(claudeModelCatalog))
	copy(out, claudeModelCatalog)
	return out, "static", nil
}
