// Hand-maintained model → context-window lookup, and the FALLBACK half of
// `resolveContextWindow`.
//
// Prefer the agent's model catalog: the sidecar already parses each CLI's
// own answer into `ModelCatalogEntry.contextWindow` (codex from
// `codex debug models`), which tracks new releases without a code change.
// This table is what answers for models the catalog can't — an offline
// machine, a catalog not yet pushed, a transcript whose agent is gone.
//
// "What's a model's max context?" changes ~quarterly when new families
// ship. Keeping a hardcoded constant avoids a network dependency and
// cache-invalidation logic — but note it does go wrong, silently and in
// the unsafe direction: the GPT-5 entry read 400k against a real 272k,
// making the ring look ~32% emptier than it was. Treat an edit here as a
// stopgap and check whether the catalog can answer instead.
//
// Match by family prefix / substring, not by exact id, so new point
// releases inside an existing family ("claude-opus-4-8-2026MMDD",
// "gpt-5.1-codex") don't need a code change. Only NEW families do.
//
// When updating: bump as `chore(shared): update model context windows`
// and verify against the upstream announcement page — DO NOT trust
// release-note rumors.
//
// MIRRORED in Swift: apps/ios/ArgusKit/Sources/ArgusKit/Engine/
// ContextWindow.swift — any change here MUST be ported there (plus
// ContextWindowTests.swift) in the same change. This is mechanically
// enforced: ArgusKit's ContextWindowLockstepTests pins this file's
// SHA-256, and iOS CI (.github/workflows/ios.yml) triggers on edits to
// this file — an unported edit fails CI until the mirror and the pinned
// hash move together. (The enforcement exists because the Fable 1M
// entry landed here on 2026-07-16 and the Swift mirror missed it — the
// iOS ring read 5x too full.)

// Type-only: erased at build time, so this cannot create a runtime cycle
// with protocol.ts (which re-exports through index.ts alongside this file).
import type { ModelCatalogEntry } from './protocol';

/** Anthropic family detector. Covers the API id form ("claude-opus-…")
 *  AND cursor-cli's bare display names ("Opus 4.7 1M Extra High
 *  Thinking", "Sonnet 4.6 Thinking"). Family words are gated by word
 *  boundaries so they don't false-positive on unrelated tokens
 *  ("octopus", "sonnetics"). */
function isAnthropicFamily(m: string): boolean {
  if (m.includes('claude')) return true;
  return /(^|[^a-z0-9])(opus|sonnet|haiku)([^a-z0-9]|$)/.test(m);
}

/** Window in tokens. First match wins, and ORDER IS LOAD-BEARING within
 *  a vendor: the Claude entries deliberately overlap (every one of them
 *  is an Anthropic model), and they're ordered most-specific-first —
 *  1M-by-flag, then 1M-by-default, then the baseline that would
 *  otherwise swallow both. Entries across vendors are mutually exclusive,
 *  so only the within-vendor order matters. Append a new Claude family
 *  ABOVE the generic entry, never below it. */
const CONTEXT_WINDOWS: Array<{
  /** Lowercased substring or regex on the lowercased model id. */
  match: (id: string) => boolean;
  window: number;
  /** Human-readable name of the family — surfaced in the tooltip so
   *  the user knows which entry matched if a mismatch is suspected. */
  family: string;
}> = [
  // Anthropic Claude — 200k baseline, with optional 1M context override
  // detected from the model id. Two id shapes coexist:
  //   - raw API ids ("claude-opus-4-7", "claude-sonnet-4-6") and Argus's
  //     internal `[1m]` suffix variant;
  //   - cursor-cli display names ("Opus 4.7 1M Extra High Thinking"),
  //     which drop the "claude-" prefix entirely and use the bare family
  //     word ("Opus" / "Sonnet" / "Haiku") with a free-form 1M token.
  // We accept either by matching on the family-word OR the "claude"
  // substring; the 1M boundary regex catches both "[1m]", "-1m", and
  // standalone " 1m " inside the cursor display string.
  {
    match: (m) =>
      isAnthropicFamily(m) &&
      (m.includes('[1m]') || /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(m)),
    window: 1_000_000,
    family: 'Claude (1M context)',
  },
  // Claude Fable — 1M is the DEFAULT, not an opt-in facet, so there is no
  // `[1m]` token in the id to key off (claude-code exposes no context
  // facet for it; see `claudeModelCatalog` in models_claude.go). Matching
  // the family word rather than the `claude-` prefix covers both id
  // shapes at once: the API id `claude-fable-5` AND cursor-cli's bare
  // display name, which is "Fable 5 1M Max Thinking" — that one carries
  // no `claude` substring, so `isAnthropicFamily` misses it and it used
  // to fall through every entry to a hidden ring.
  //
  // Must stay ABOVE the generic Claude entry: `claude-fable-5` satisfies
  // `isAnthropicFamily`, so the 200k baseline would otherwise claim it
  // and the ring would read 5x too full.
  {
    match: (m) => /(^|[^a-z0-9])fable([^a-z0-9]|$)/.test(m),
    window: 1_000_000,
    family: 'Claude Fable',
  },
  // Claude Opus 5 — like Fable, 1M is the DEFAULT rather than an opt-in
  // facet, so a turn run without `context: "1m"` still reports the bare
  // `claude-opus-5` and would otherwise fall through to the 200k
  // baseline (ring 5x too full). Verified against the CLI's own
  // `result.modelUsage["claude-opus-5"].contextWindow` = 1_000_000.
  //
  // Version-gated on `5` rather than the bare family word, because the
  // Opus 4.x ids share it and are NOT covered by this entry. The
  // `[-\s]?` separator spans both id shapes — the API id
  // `claude-opus-5` (with or without a point-release suffix) and
  // cursor-cli's display form "Opus 5 …" — while the trailing boundary
  // keeps `opus-5` from swallowing a future `opus-50`.
  {
    match: (m) => /(^|[^a-z0-9])opus[-\s]?5([^a-z0-9]|$)/.test(m),
    window: 1_000_000,
    family: 'Claude Opus 5',
  },
  {
    match: (m) => isAnthropicFamily(m),
    window: 200_000,
    family: 'Claude',
  },

  // OpenAI GPT-5 family (incl. gpt-5-codex) — 272k. Verified against
  // `codex debug models`, which reports context_window=272000 for every
  // listed gpt-5.x slug (5.4, 5.5, 5.6-sol/terra/luna). This entry was
  // 400_000, which made the ring read ~32% emptier than reality — the
  // unsafe direction, since the ring exists to warn before overflow.
  //
  // Prefer the agent's own catalog over this entry: `resolveContextWindow`
  // reads ModelCatalogEntry.contextWindow, which comes from the CLI itself
  // and tracks new releases without a code change. This stays the fallback
  // for transcripts whose machine/catalog is no longer reachable.
  {
    match: (m) => m.includes('gpt-5'),
    window: 272_000,
    family: 'GPT-5',
  },

  // OpenAI GPT-4.1 — 1M.
  {
    match: (m) => m.includes('gpt-4.1'),
    window: 1_000_000,
    family: 'GPT-4.1',
  },

  // OpenAI GPT-4o / 4-turbo — 128k.
  {
    match: (m) => m.includes('gpt-4o') || m.includes('gpt-4-turbo'),
    window: 128_000,
    family: 'GPT-4o',
  },

  // OpenAI o-series reasoning models (o3, o4-mini, etc.) — 200k.
  {
    match: (m) => /(^|[^a-z0-9])o[34](-|$)/.test(m),
    window: 200_000,
    family: 'OpenAI o-series',
  },
];

export interface ContextWindowInfo {
  /** Total context capacity of the model, in tokens. */
  window: number;
  /** Human-readable family name (e.g., "Claude (1M context)"). */
  family: string;
}

/**
 * Look up the model's max context window. Returns `null` for unknown
 * models so the UI can hide the ring rather than render a misleading
 * percentage against a guessed denominator.
 *
 * Accepts both raw API ids ("claude-opus-4-7") and human-readable
 * display strings ("Opus 4.7 1M Extra High Thinking") because cursor-cli
 * surfaces the latter; matching is substring-based and case-insensitive.
 */
export function lookupContextWindow(
  model: string | null | undefined,
): ContextWindowInfo | null {
  if (!model) return null;
  const lc = model.toLowerCase();
  for (const entry of CONTEXT_WINDOWS) {
    if (entry.match(lc)) {
      return { window: entry.window, family: entry.family };
    }
  }
  return null;
}

/**
 * Resolve a model's context window. Three sources, most authoritative
 * first.
 *
 * 1. `reportedWindow` — what the turn itself said, read off the final
 *    chunk's `meta.modelContextWindow`. This is the only source that knows
 *    the window ACTUALLY in effect: it is per-thread, and it accounts for
 *    the usable ceiling rather than the nominal one. Codex reports 258400
 *    where its catalog says 272000, the difference being the model's
 *    `effective_context_window_percent` (95) — the 5% it holds back. A
 *    name-keyed source cannot express either, since the same model id can
 *    run with different windows (`gpt-5.6-sol` lists context_window 272000
 *    but max_context_window 872000).
 * 2. The agent's model catalog — the CLI's own answer per slug
 *    (`codex debug models` → `ModelCatalogEntry.contextWindow`). Tracks
 *    new releases with no code change.
 * 3. `CONTEXT_WINDOWS` — the static table, for transcripts whose machine
 *    is offline or whose agent is gone. It needs a matcher edit per family
 *    and fails silently when it drifts (it read 400k for gpt-5.x against a
 *    real 272k until this was wired up).
 *
 * Catalog matching is exact-then-case-insensitive on the entry id, NOT the
 * substring matching the table uses: a catalog id is the CLI's own slug,
 * so a loose match risks pairing a model with a sibling's window.
 *
 * A reported window is trusted even when neither name-keyed source
 * recognises the model — the number is authoritative on its own, and the
 * family label is only cosmetic.
 */
export function resolveContextWindow(
  model: string | null | undefined,
  catalog: ModelCatalogEntry[] | null | undefined,
  reportedWindow?: number | null,
): ContextWindowInfo | null {
  let named: ContextWindowInfo | null = null;
  if (model && catalog?.length) {
    const lc = model.toLowerCase();
    const hit =
      catalog.find((e) => e.id === model) ?? catalog.find((e) => e.id.toLowerCase() === lc);
    if (hit?.contextWindow && hit.contextWindow > 0) {
      named = { window: hit.contextWindow, family: hit.displayName || hit.id };
    }
  }
  named ??= lookupContextWindow(model);

  if (typeof reportedWindow === 'number' && reportedWindow > 0) {
    return { window: reportedWindow, family: named?.family ?? model ?? 'model' };
  }
  return named;
}
