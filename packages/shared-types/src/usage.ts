// Token-usage normalization across the three CLI adapters.
//
// Every adapter emits a `final`-kind chunk whose `meta` is the raw
// upstream event verbatim, but each upstream uses its own field names
// and field set:
//
//   claude-code (Anthropic stream-json):
//     meta.usage.input_tokens
//     meta.usage.output_tokens
//     meta.usage.cache_read_input_tokens
//     meta.usage.cache_creation_input_tokens
//     meta.total_cost_usd            (root, USD)
//     meta.duration_api_ms           (root, ms)
//
//   codex (≥ 0.121, turn.completed event):
//     meta.usage.input_tokens
//     meta.usage.output_tokens
//     meta.usage.cached_input_tokens
//
//   cursor-cli (result event):
//     meta.usage.inputTokens
//     meta.usage.outputTokens
//     meta.usage.cacheReadTokens
//     meta.usage.cacheWriteTokens
//     meta.duration_api_ms
//
// Lives in shared-types so the eventual server-side persistence /
// aggregation pass (tier B) reuses the same parser the client uses
// today — there's exactly one place in the codebase that knows the
// adapter-specific shape of a token-usage payload.

import type { AgentType } from './protocol';

/** Normalized per-event token tally. All four token counts default to 0
 *  so callers can sum without null-guarding every field. `costUsd` and
 *  `durationApiMs` are optional because not every adapter emits them. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from a previously-cached prompt. Anthropic prices these
   *  at ~10% of normal input; OpenAI prices them at 50%. */
  cacheReadTokens: number;
  /** Tokens written into a NEW cache entry. Anthropic-only concept and
   *  costs ~25% more than normal input. Codex / OpenAI don't surface this. */
  cacheWriteTokens: number;
  /** USD as reported by the adapter (claude-code only today). */
  costUsd?: number;
  /** Milliseconds spent waiting on the upstream API for this turn.
   *  Useful as a "where did the time go?" signal — distinct from the
   *  command's wall-clock duration which also covers tool execution. */
  durationApiMs?: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** True iff any field carries a non-zero / set value. Used to decide
 *  whether to render the badge at all (don't show "↑0 ↓0"). */
export function hasUsage(u: TokenUsage): boolean {
  return (
    u.inputTokens > 0 ||
    u.outputTokens > 0 ||
    u.cacheReadTokens > 0 ||
    u.cacheWriteTokens > 0 ||
    (u.costUsd ?? 0) > 0
  );
}

/** Pointwise sum. Treats unset costUsd / durationApiMs as 0; both fields
 *  end up unset on the result if neither operand had them, so the badge
 *  can still hide the cost line for codex-only sessions. */
export function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
  const cost = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  if (cost > 0 || a.costUsd !== undefined || b.costUsd !== undefined) {
    out.costUsd = cost;
  }
  const apiMs = (a.durationApiMs ?? 0) + (b.durationApiMs ?? 0);
  if (apiMs > 0 || a.durationApiMs !== undefined || b.durationApiMs !== undefined) {
    out.durationApiMs = apiMs;
  }
  return out;
}

/** Pull a number out of a JSON-ish object regardless of whether the
 *  source serialized it as a JS number or a numeric string. Returns
 *  `undefined` for missing / unparseable fields so callers can detect
 *  "this adapter doesn't emit this field" vs "this adapter emits 0". */
function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = asNumber(obj[k]);
    if (v !== undefined) return v;
  }
  return 0;
}

/**
 * Parse the raw `meta` of a `final`-kind chunk into normalized token
 * usage. Returns `null` when the meta has no recognizable usage payload
 * — e.g. an error chunk, a turn that was cancelled before completion,
 * or an adapter version that doesn't emit usage.
 *
 * The adapter type is required because the field names diverge between
 * upstreams (snake_case vs camelCase, `cached_input_tokens` vs
 * `cacheReadTokens`). Custom adapters (anything outside the built-in
 * three) fall through to a best-effort parse that probes both naming
 * conventions — works if the custom adapter mirrors one of the
 * existing schemas.
 */
export function parseUsage(
  adapterType: AgentType,
  meta: Record<string, unknown> | null | undefined,
): TokenUsage | null {
  if (!meta) return null;
  const usage = (meta.usage as Record<string, unknown> | undefined) ?? undefined;
  if (!usage) return null;

  let parsed: TokenUsage;
  switch (adapterType) {
    case 'claude-code':
      parsed = {
        inputTokens: pickNumber(usage, 'input_tokens'),
        outputTokens: pickNumber(usage, 'output_tokens'),
        cacheReadTokens: pickNumber(usage, 'cache_read_input_tokens'),
        cacheWriteTokens: pickNumber(usage, 'cache_creation_input_tokens'),
      };
      // Anthropic surfaces both cost and api duration at the meta root,
      // not inside `usage`. Hoist them so the badge can show "$0.42".
      {
        const cost = asNumber(meta.total_cost_usd);
        if (cost !== undefined) parsed.costUsd = cost;
        const apiMs = asNumber(meta.duration_api_ms);
        if (apiMs !== undefined) parsed.durationApiMs = apiMs;
      }
      break;

    case 'codex': {
      // OpenAI's Responses API reports `input_tokens` as the TOTAL prompt
      // (cached + fresh), with `cached_input_tokens` as the cached subset.
      // Anthropic's claude-code reports them as disjoint buckets. Normalize
      // codex to the disjoint convention so `inputTokens + cacheReadTokens`
      // is a meaningful sum across every adapter.
      const totalIn = pickNumber(usage, 'input_tokens');
      const cached = pickNumber(usage, 'cached_input_tokens');
      parsed = {
        inputTokens: Math.max(0, totalIn - cached),
        outputTokens: pickNumber(usage, 'output_tokens'),
        cacheReadTokens: cached,
        // OpenAI has no cache-write concept.
        cacheWriteTokens: 0,
      };
      break;
    }

    case 'cursor-cli':
      parsed = {
        inputTokens: pickNumber(usage, 'inputTokens'),
        outputTokens: pickNumber(usage, 'outputTokens'),
        cacheReadTokens: pickNumber(usage, 'cacheReadTokens'),
        cacheWriteTokens: pickNumber(usage, 'cacheWriteTokens'),
      };
      {
        const apiMs = asNumber(meta.duration_api_ms);
        if (apiMs !== undefined) parsed.durationApiMs = apiMs;
      }
      break;

    default:
      // Unknown / custom adapter — try both conventions. First match wins.
      parsed = {
        inputTokens: pickNumber(usage, 'input_tokens', 'inputTokens'),
        outputTokens: pickNumber(usage, 'output_tokens', 'outputTokens'),
        cacheReadTokens: pickNumber(
          usage,
          'cache_read_input_tokens',
          'cached_input_tokens',
          'cacheReadTokens',
        ),
        cacheWriteTokens: pickNumber(
          usage,
          'cache_creation_input_tokens',
          'cacheWriteTokens',
        ),
      };
      break;
  }

  return hasUsage(parsed) ? parsed : null;
}

/**
 * Best-effort extraction of the model name from a chunk's `meta`.
 * Returns `null` when the meta has no recognizable model field.
 *
 * Each adapter advertises the model in a slightly different location:
 *
 *   claude-code system init:   meta.model            ("claude-3-5-sonnet-...")
 *   claude-code assistant:     meta.message.model    (wraps the API response)
 *   cursor-cli system init:    meta.model            ("Opus 4.7 1M Extra High Thinking")
 *   codex session_configured:  meta.model OR meta.msg.model (codex wraps events
 *                                                            in a `msg` envelope
 *                                                            for some streams)
 *   codex thread.started:      meta.session.model    (newer 0.121+ shape)
 *
 * Probes them all in priority order and returns the first non-empty
 * string. Adapter-agnostic on purpose so custom adapters that mirror
 * one of the upstream schemas just work without a switch case.
 *
 * NOTE: This is intentionally NOT keyed by `AgentType` like `parseUsage`
 * — the model name lives in different *events* per adapter, not in
 * different *fields* per adapter. The caller scans every chunk's meta
 * looking for the first match, so a defensive multi-path walker is the
 * right shape here.
 */
export function parseModel(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta) return null;

  // Probe order matters: top-level wins over nested so we don't pick up
  // a stale inner model from a wrapped envelope when the outer event
  // already advertises one.
  const candidates: unknown[] = [
    meta.model,
    (meta.message as Record<string, unknown> | undefined)?.model,
    (meta.msg as Record<string, unknown> | undefined)?.model,
    (meta.session as Record<string, unknown> | undefined)?.model,
    ((meta.msg as Record<string, unknown> | undefined)?.session as
      | Record<string, unknown>
      | undefined)?.model,
  ];

  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
