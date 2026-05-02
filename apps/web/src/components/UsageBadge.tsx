import type { AgentType, ResultChunkDTO, TokenUsage } from '@argus/shared-types';
import {
  formatMs,
  formatTokensShort,
  useSessionContext,
  useSessionUsage,
  type SessionContext,
} from '../lib/usage';
import { Tooltip } from './ui/Tooltip';

/**
 * Compact per-session token-usage badge that lives in the SessionPanel
 * header. Aggregates client-side from `chunks` (every `final`-kind
 * chunk's `meta` already arrives via the WS stream — no extra HTTP
 * fetch needed). The full breakdown (cache read/write, $cost, API
 * time) is in the Radix-powered hover tooltip; the always-visible
 * Session right pane mirrors the token rows for at-a-glance access.
 *
 * The leading donut shows context-window utilization for the LATEST
 * turn (not cumulative), since each CLI re-sends the full history on
 * every turn — see `useSessionContext`. The donut is hidden when the
 * model isn't in the window lookup table so unknown models degrade
 * gracefully to the bare ↑/↓ arrows.
 */
export function UsageBadge({
  chunks,
  agentType,
}: {
  chunks: ResultChunkDTO[];
  agentType: AgentType | undefined;
}) {
  const total = useSessionUsage(chunks, agentType);
  const ctx = useSessionContext(chunks, agentType);
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
    <Tooltip content={<UsageBreakdown u={total} ctx={ctx} />}>
      <span className="inline-flex shrink-0 cursor-default items-center gap-1.5 rounded-md border border-default bg-surface-1/60 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-fg-tertiary">
        {ctx && <ContextRing percent={ctx.percent} />}
        <span>{inOut}</span>
      </span>
    </Tooltip>
  );
}

/** SVG donut sized to match the badge's line-height. Threshold colors:
 *  green < 60% (plenty of headroom), amber 60–85% (consider /clear soon),
 *  red ≥ 85% (model will start dropping context or refusing). The track
 *  uses currentColor at 0.2 opacity so it tints with the active state.
 *  rotated -90° so the arc grows clockwise from 12 o'clock — the
 *  conventional "fullness" direction. */
function ContextRing({ percent }: { percent: number }) {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference * (1 - Math.min(1, Math.max(0, percent / 100)));
  const color =
    percent < 60
      ? 'text-emerald-500'
      : percent < 85
        ? 'text-amber-500'
        : 'text-red-500';
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      className={color}
      aria-label={`context ${Math.round(percent)}%`}
    >
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 8 8)"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Two-column key/value grid used in the tooltip body. Numbers are
 *  right-aligned with `tabular-nums` so adjacent rows stay column-
 *  aligned even when digit counts differ ("16,114" vs "5"). Context
 *  rows live ABOVE a divider because they describe the latest turn's
 *  live state, while everything below is cumulative-across-the-session
 *  — distinct semantics, worth the visual separation. */
function UsageBreakdown({ u, ctx }: { u: TokenUsage; ctx: SessionContext | null }) {
  const totalRows: Array<[string, string]> = [
    ['Input', u.inputTokens.toLocaleString()],
    ['Output', u.outputTokens.toLocaleString()],
  ];
  if (u.cacheReadTokens > 0) {
    totalRows.push(['Cache read', u.cacheReadTokens.toLocaleString()]);
  }
  if (u.cacheWriteTokens > 0) {
    totalRows.push(['Cache write', u.cacheWriteTokens.toLocaleString()]);
  }
  if (u.costUsd !== undefined && u.costUsd > 0) {
    totalRows.push(['Cost', `$${u.costUsd.toFixed(4)}`]);
  }
  if (u.durationApiMs !== undefined && u.durationApiMs > 0) {
    totalRows.push(['API time', formatMs(u.durationApiMs)]);
  }

  return (
    <div className="font-mono text-[11px] tabular-nums">
      {ctx && (
        <>
          <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
            <RowCells
              k="Context"
              v={`${ctx.used.toLocaleString()} / ${ctx.window.toLocaleString()}`}
            />
            <RowCells k="" v={`${ctx.percent.toFixed(1)}%  ·  ${ctx.family}`} />
          </div>
          <div className="my-1.5 border-t border-default" />
        </>
      )}
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
        {totalRows.map(([k, v]) => (
          <RowCells key={k} k={k} v={v} />
        ))}
      </div>
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
      <span className="text-fg-tertiary">{k}</span>
      <span className="text-right text-fg-primary">{v}</span>
    </>
  );
}
