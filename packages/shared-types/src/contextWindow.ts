// Hand-maintained model → context-window lookup.
//
// "What's a model's max context?" is a value that changes ~quarterly when
// new families ship. We keep it as a hardcoded constant rather than a
// remote registry because:
//   - the alternative (Anthropic/OpenAI model APIs, JSON CDN) adds a network
//     dependency + cache-invalidation logic for a value that's rarely wrong;
//   - adapter-emitted context-window metadata isn't uniformly available
//     across the three CLIs we support.
//
// Match by family prefix / substring, not by exact id, so new point
// releases inside an existing family ("claude-opus-4-8-2026MMDD",
// "gpt-5.1-codex") don't need a code change. Only NEW families do.
//
// When updating: bump as `chore(shared): update model context windows`
// and verify against the upstream announcement page — DO NOT trust
// release-note rumors.

/** Anthropic family detector. Covers the API id form ("claude-opus-…")
 *  AND cursor-cli's bare display names ("Opus 4.7 1M Extra High
 *  Thinking", "Sonnet 4.6 Thinking"). Family words are gated by word
 *  boundaries so they don't false-positive on unrelated tokens
 *  ("octopus", "sonnetics"). */
function isAnthropicFamily(m: string): boolean {
  if (m.includes('claude')) return true;
  return /(^|[^a-z0-9])(opus|sonnet|haiku)([^a-z0-9]|$)/.test(m);
}

/** Window in tokens. Keep families ordered roughly newest-first so the
 *  search hits the most likely current model fastest, but correctness
 *  doesn't depend on order — every entry is mutually exclusive by
 *  substring match. */
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
  {
    match: (m) => isAnthropicFamily(m),
    window: 200_000,
    family: 'Claude',
  },

  // OpenAI GPT-5 family (incl. gpt-5-codex) — 400k.
  {
    match: (m) => m.includes('gpt-5'),
    window: 400_000,
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
