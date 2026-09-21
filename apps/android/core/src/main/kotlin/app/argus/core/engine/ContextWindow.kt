package app.argus.core.engine

import app.argus.core.model.ModelCatalogEntry

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/ContextWindow.swift,
// which mirrors packages/shared-types/src/contextWindow.ts.

/**
 * The hand-maintained model → context-window lookup behind the donut
 * ring. Match by family substring, not exact id, so point releases don't
 * need a code change; keep the table in lockstep with the TS original
 * (`chore(shared): update model context windows` commits).
 *
 * The lockstep is ENFORCED: ContextWindowLockstepTest pins the TS file's
 * SHA-256 and Android CI triggers on edits to it, so a TS-side change
 * fails CI until this mirror (and the pin) move with it.
 */
data class ContextWindowInfo(
    /** Total context capacity in tokens. */
    val window: Int,
    /** Human-readable family label, surfaced in tooltips. */
    val family: String,
)

object ContextWindows {
    private val anthropicFamilyRegex = Regex("(^|[^a-z0-9])(opus|sonnet|haiku)([^a-z0-9]|\$)")
    private val millionTokenRegex = Regex("(^|[^a-z0-9])1m([^a-z0-9]|\$)")
    private val fableRegex = Regex("(^|[^a-z0-9])fable([^a-z0-9]|\$)")
    private val opusFiveRegex = Regex("(^|[^a-z0-9])opus[-\\s]?5([^a-z0-9]|\$)")
    private val oSeriesRegex = Regex("(^|[^a-z0-9])o[34](-|\$)")

    /**
     * Anthropic family detector: the API id form ("claude-…") and
     * cursor-cli's bare display names ("Opus 4.7 1M Extra High
     * Thinking"). Family words are word-boundary-gated so "octopus"
     * doesn't match.
     */
    internal fun isAnthropicFamily(model: String): Boolean {
        if (model.contains("claude")) return true
        return anthropicFamilyRegex.containsMatchIn(model)
    }

    internal fun hasMillionTokenMarker(model: String): Boolean {
        if (model.contains("[1m]")) return true
        return millionTokenRegex.containsMatchIn(model)
    }

    private class Entry(
        val match: (String) -> Boolean,
        val window: Int,
        val family: String,
    )

    // First match wins, and ORDER IS LOAD-BEARING within a vendor: the
    // Claude entries deliberately overlap (every one of them is an
    // Anthropic model) and are ordered most-specific-first — 1M-by-flag,
    // then 1M-by-default, then the baseline that would otherwise swallow
    // both. Append a new Claude family ABOVE the generic entry, never
    // below it. (Mirrors the TS table's ordering rule.)
    private val entries: List<Entry> = listOf(
        Entry(
            match = { isAnthropicFamily(it) && hasMillionTokenMarker(it) },
            window = 1_000_000,
            family = "Claude (1M context)",
        ),
        // Claude Fable — 1M is the DEFAULT, not an opt-in facet, so there
        // is no `[1m]` token in the id to key off. Matching the family
        // word covers both id shapes at once: the API id `claude-fable-5`
        // AND cursor-cli's bare display name "Fable 5 1M Max Thinking"
        // (no "claude" substring — isAnthropicFamily misses it). Must
        // stay ABOVE the generic Claude entry, which would otherwise
        // claim `claude-fable-5` and read the ring 5x too full.
        Entry(
            match = { fableRegex.containsMatchIn(it) },
            window = 1_000_000,
            family = "Claude Fable",
        ),
        // Claude Opus 5 — like Fable, 1M is the DEFAULT rather than an
        // opt-in facet, so a turn run without `context: "1m"` reports the
        // bare `claude-opus-5` and would otherwise hit the 200k baseline
        // (ring 5x too full). Version-gated on `5`: the Opus 4.x ids
        // share the family word and are NOT covered here. `[-\s]?` spans
        // the API id `claude-opus-5` and cursor-cli's "Opus 5 …" display
        // form; the trailing boundary keeps it off a future `opus-50`.
        Entry(
            match = { opusFiveRegex.containsMatchIn(it) },
            window = 1_000_000,
            family = "Claude Opus 5",
        ),
        Entry(match = { isAnthropicFamily(it) }, window = 200_000, family = "Claude"),
        // OpenAI GPT-5 family — 272k. Verified against `codex debug
        // models`, which reports context_window=272000 for every listed
        // gpt-5.x slug (5.4, 5.5, 5.6-sol/terra/luna). This was 400_000,
        // which made the ring read ~32% emptier than reality — the unsafe
        // direction, since the ring exists to warn before overflow.
        // Prefer `resolve(model, catalog)`, which reads the CLI's own
        // catalog; this entry is the fallback.
        Entry(match = { it.contains("gpt-5") }, window = 272_000, family = "GPT-5"),
        Entry(match = { it.contains("gpt-4.1") }, window = 1_000_000, family = "GPT-4.1"),
        Entry(
            match = { it.contains("gpt-4o") || it.contains("gpt-4-turbo") },
            window = 128_000,
            family = "GPT-4o",
        ),
        Entry(
            match = { oSeriesRegex.containsMatchIn(it) },
            window = 200_000,
            family = "OpenAI o-series",
        ),
    )

    /**
     * null for unknown models — hide the ring rather than render a
     * percentage against a guessed denominator.
     */
    fun lookup(model: String?): ContextWindowInfo? {
        if (model.isNullOrEmpty()) return null
        val lowercased = model.lowercase()
        for (entry in entries) {
            if (entry.match(lowercased)) {
                return ContextWindowInfo(window = entry.window, family = entry.family)
            }
        }
        return null
    }

    /**
     * Resolve a model's context window. Three sources, most
     * authoritative first.
     *
     * Port of `resolveContextWindow` in
     * packages/shared-types/src/contextWindow.ts.
     *
     * 1. [reportedWindow] — what the turn itself said, read off the final
     *    chunk's `meta.modelContextWindow`. The only source that knows the
     *    window ACTUALLY in effect: per-thread, and the usable ceiling
     *    rather than the nominal one. Codex reports 258400 where its
     *    catalog says 272000 — the 5% held back by the model's
     *    `effective_context_window_percent`.
     * 2. The agent's catalog (codex from `codex debug models`), which
     *    tracks new releases with no code change.
     * 3. The static table, for transcripts whose agent is gone.
     *
     * Catalog matching is exact-then-case-insensitive on the entry id,
     * NOT the substring matching the table uses: a catalog id is the
     * CLI's own slug, so a loose match risks pairing a model with a
     * sibling's window.
     */
    fun resolve(
        model: String?,
        catalog: List<ModelCatalogEntry>? = null,
        reportedWindow: Int? = null,
    ): ContextWindowInfo? {
        var named: ContextWindowInfo? = null
        if (!model.isNullOrEmpty() && !catalog.isNullOrEmpty()) {
            val lowercased = model.lowercase()
            val hit = catalog.firstOrNull { it.id == model }
                ?: catalog.firstOrNull { it.id.lowercase() == lowercased }
            val window = hit?.contextWindow
            if (hit != null && window != null && window > 0) {
                named = ContextWindowInfo(
                    window = window,
                    family = hit.displayName.ifEmpty { hit.id },
                )
            }
        }
        if (named == null) named = lookup(model)

        // Trusted even when neither name-keyed source recognises the
        // model: the number is authoritative on its own and the family
        // label is only cosmetic.
        if (reportedWindow != null && reportedWindow > 0) {
            return ContextWindowInfo(
                window = reportedWindow,
                family = named?.family ?: model ?: "model",
            )
        }
        return named
    }
}
