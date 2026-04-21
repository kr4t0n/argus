import type { AgentType, ResultChunkDTO, TokenUsage } from '@argus/shared-types';
import { formatMs, formatTokensShort, useSessionUsage } from '../lib/usage';
import { Tooltip } from './ui/Tooltip';

/**
 * Compact per-session token-usage badge that lives in the SessionPanel
 * header. Aggregates client-side from `chunks` (every `final`-kind
 * chunk's `meta` already arrives via the WS stream — no extra HTTP
 * fetch needed). The full breakdown (cache read/write, $cost, API
 * time) is in the Radix-powered hover tooltip; the always-visible
 * Session right pane mirrors the token rows for at-a-glance access.
 */
export function UsageBadge({
  chunks,
  agentType,
}: {
  chunks: ResultChunkDTO[];
  agentType: AgentType | undefined;
}) {
  const total = useSessionUsage(chunks, agentType);
  if (!total) return null;

  // The two visible numbers — kept terse so the badge fits on the same
  // line as the title even on a narrow window. Cache + cost go in the
  // tooltip because they're "drill-down" detail, not glanceable.
  // ↑ rolls in cache reads + writes since both are prompt-side tokens;
  // showing only `inputTokens` understates real usage by ~10x once
  // caching kicks in (claude-code, cursor). Codex reports everything
  // under inputTokens already, so this sum is a no-op there.
  const promptTotal = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  const inOut = `↑ ${formatTokensShort(promptTotal)} ↓ ${formatTokensShort(total.outputTokens)}`;

  return (
    <Tooltip content={<UsageBreakdown u={total} />}>
      <span className="inline-flex shrink-0 cursor-default items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900/60 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-neutral-400">
        {inOut}
      </span>
    </Tooltip>
  );
}

/** Two-column key/value grid used in the tooltip body. Numbers are
 *  right-aligned with `tabular-nums` so adjacent rows stay column-
 *  aligned even when digit counts differ ("16,114" vs "5"). */
function UsageBreakdown({ u }: { u: TokenUsage }) {
  const rows: Array<[string, string]> = [
    ['Input', u.inputTokens.toLocaleString()],
    ['Output', u.outputTokens.toLocaleString()],
  ];
  if (u.cacheReadTokens > 0) {
    rows.push(['Cache read', u.cacheReadTokens.toLocaleString()]);
  }
  if (u.cacheWriteTokens > 0) {
    rows.push(['Cache write', u.cacheWriteTokens.toLocaleString()]);
  }
  if (u.costUsd !== undefined && u.costUsd > 0) {
    rows.push(['Cost', `$${u.costUsd.toFixed(4)}`]);
  }
  if (u.durationApiMs !== undefined && u.durationApiMs > 0) {
    rows.push(['API time', formatMs(u.durationApiMs)]);
  }
  return (
    <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px] tabular-nums">
      {rows.map(([k, v]) => (
        <RowCells key={k} k={k} v={v} />
      ))}
    </div>
  );
}

/** Extracted so the grid sees a flat sequence of cells (the parent
 *  `<div>` is `display:grid`, so each fragment must contribute exactly
 *  two children). Using two spans rather than a fragment also lets
 *  React reconcile the `key` on the row label cleanly. */
function RowCells({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="text-neutral-500">{k}</span>
      <span className="text-right text-neutral-100">{v}</span>
    </>
  );
}
