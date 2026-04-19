import { useMemo } from 'react';
import type { AgentType, ResultChunkDTO, TokenUsage } from '@argus/shared-types';
import { ZERO_USAGE, hasUsage, parseModel, parseUsage, sumUsage } from '@argus/shared-types';

/**
 * Aggregate every `final`-kind chunk's usage payload into one running
 * total for the session. Returns `null` when:
 *   - the agent type is unknown (no parser to pick), or
 *   - no final chunk has surfaced a usage payload yet (empty session,
 *     pre-first-turn, all turns cancelled, …).
 *
 * Memoized on (chunks reference, agentType) — Zustand always swaps
 * `entry.chunks` for a new array reference whenever a chunk arrives,
 * so the recompute fires on every WS update for the active session
 * and stays a no-op otherwise.
 *
 * Lives in `lib/` (not co-located with UsageBadge) because both the
 * compact header badge AND the right-pane breakdown read the same
 * total — keeping the parse + sum in one place avoids two views drifting
 * apart on, e.g., how cancelled-turn meta is treated.
 */
export function useSessionUsage(
  chunks: ResultChunkDTO[],
  agentType: AgentType | undefined,
): TokenUsage | null {
  return useMemo(() => {
    if (!agentType) return null;
    let acc = ZERO_USAGE;
    let any = false;
    for (const c of chunks) {
      if (c.kind !== 'final') continue;
      const u = parseUsage(agentType, c.meta);
      if (!u) continue;
      acc = sumUsage(acc, u);
      any = true;
    }
    return any && hasUsage(acc) ? acc : null;
  }, [chunks, agentType]);
}

/**
 * First model name found in any chunk's `meta` for the active session.
 * Returns `null` until at least one chunk advertising a model has
 * arrived (typically the very first system / init / session-configured
 * progress chunk a turn emits).
 *
 * We return the FIRST match (not the latest) because the model is set
 * once at session init and doesn't change mid-turn — scanning forward
 * gives us the most stable answer the soonest. If a future feature
 * lets users swap models per-turn, switch this to `findLast` and the
 * UI rerenders for free.
 */
export function useSessionModel(chunks: ResultChunkDTO[]): string | null {
  return useMemo(() => {
    for (const c of chunks) {
      const m = parseModel(c.meta);
      if (m) return m;
    }
    return null;
  }, [chunks]);
}

/** k/M short form for token counts. Used by the compact header badge
 *  where horizontal space is at a premium. The right-pane breakdown
 *  uses `toLocaleString()` directly because it has room for full-
 *  precision numbers. */
export function formatTokensShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Human-friendly millisecond formatter shared between the badge tooltip
 *  and the right-pane "api time" row. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}
