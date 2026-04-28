import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActivityDay } from '@argus/shared-types';
import { cn } from '../lib/utils';

type Props = {
  /** Dense, ascending-by-date list. The first day's day-of-week
   *  determines where in the leading column the run starts (the
   *  preceding cells are rendered as empty placeholders). */
  days: ActivityDay[];
  /** Minimum side of each square in pixels. Cells expand from this
   *  baseline to fill the container's available width — see the
   *  ResizeObserver block below. Default 11 matches GitHub's
   *  contributions chart density. */
  cell?: number;
  /** Pixel gap between cells. */
  gap?: number;
};

/**
 * GitHub-style activity heatmap.
 *
 * Layout:
 *   - 7 rows, one per weekday (Sun..Sat by default — the same layout
 *     GitHub uses on github.com).
 *   - N columns, one per ISO week. The first column may have leading
 *     empty cells if the window's first day isn't a Sunday; the last
 *     column may have trailing empty cells if today isn't a Saturday.
 *     Empty cells are rendered transparent so the grid stays square.
 *   - Cell color is bucketed by count via a fixed quintile scale
 *     (empty / 1 / 2-3 / 4-6 / 7+ commands). Tuned for a single-user
 *     dashboard where the daily counts are typically small; tweaks
 *     are easy if the distribution skews heavier later.
 *
 * No third-party calendar/heatmap library — the grid is ~80 lines of
 * SVG. Hover tooltip uses the native `<title>` element which gives
 * us free a11y + keyboardless tooltips without a Radix dependency.
 */
// Pixel height of the month-labels row sitting above the grid. 14 px
// fits a 10 px text comfortably with a hair of breathing room.
const MONTH_LABEL_H = 14;

// Min column gap between two month labels. Months span ~4 weeks, but
// the calendar can put two month transitions within 1-2 columns of
// each other (e.g. when a month starts mid-week). Skipping labels
// closer than this prevents text collisions.
const MIN_LABEL_GAP_COLS = 3;

export function ActivityHeatmap({ days, cell = 11, gap = 2 }: Props) {
  const grid = useMemo(() => buildGrid(days), [days]);
  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.count), 0), [days]);
  const total = useMemo(() => days.reduce((m, d) => m + d.count, 0), [days]);
  const months = useMemo(() => buildMonthLabels(days), [days]);

  // Measure the wrapping element and grow each cell so the grid spans
  // the container's full width. Falls back to the `cell` prop when
  // the measurement hasn't landed yet (initial paint before the
  // observer fires) or when the container is narrower than the
  // baseline grid would naturally need.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapWidth, setWrapWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWrapWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Solve for cell size: weeks * cell + (weeks - 1) * gap == wrapWidth
  // → cell = (wrapWidth - (weeks - 1) * gap) / weeks. Kept fractional
  // so the grid spans the container exactly (Math.floor previously
  // left ~39 px of slack for a 726 px container at 53 weeks). Rects
  // already render with anti-aliased rounded corners (rx=2), so
  // sub-pixel widths blend in cleanly. Falls back to the `cell` prop
  // until ResizeObserver fires the first measurement, and treats
  // `cell` as a minimum so a narrow viewport horizontally scrolls
  // (via the wrapper's overflow-x-auto) instead of crushing cells
  // below 11 px.
  const fitted =
    grid.weeks > 0 && wrapWidth > 0
      ? (wrapWidth - (grid.weeks - 1) * gap) / grid.weeks
      : cell;
  const effectiveCell = Math.max(cell, fitted);
  const width = grid.weeks * effectiveCell + (grid.weeks - 1) * gap;
  const gridH = 7 * effectiveCell + 6 * gap;
  const height = MONTH_LABEL_H + gridH;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <div className="text-[11px] uppercase tracking-widest text-fg-muted">
          {total.toLocaleString()} command{total === 1 ? '' : 's'} in the last year
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-fg-muted">
          <span>less</span>
          {[0, 1, 2, 3, 4].map((b) => (
            <span
              key={b}
              className={cn('inline-block rounded-sm', bucketClass(b))}
              style={{ width: cell, height: cell }}
            />
          ))}
          <span>more</span>
        </div>
      </div>
      <div ref={wrapRef} className="w-full overflow-x-auto">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Activity heatmap: ${total} commands in the last year, peak ${max} on a single day.`}
        >
          {/* Month labels along the top. The text origin (`y`) sits at
              the BASELINE — placing the baseline at MONTH_LABEL_H - 3
              leaves a 3 px gutter between the label and the first row
              of cells. */}
          {months.map((m) => (
            <text
              key={m.col}
              x={m.col * (effectiveCell + gap)}
              y={MONTH_LABEL_H - 3}
              className="fill-fg-tertiary"
              fontSize={10}
            >
              {m.text}
            </text>
          ))}
          {/* Grid cells, offset down by MONTH_LABEL_H so they sit under
              the label row. */}
          <g transform={`translate(0, ${MONTH_LABEL_H})`}>
            {grid.cells.map((c) => (
              <rect
                key={`${c.col}-${c.row}`}
                x={c.col * (effectiveCell + gap)}
                y={c.row * (effectiveCell + gap)}
                width={effectiveCell}
                height={effectiveCell}
                rx={2}
                ry={2}
                className={c.day ? bucketClass(bucketize(c.day.count)) : ''}
                fill={c.day ? undefined : 'transparent'}
              >
                {c.day && (
                  <title>
                    {c.day.count} command{c.day.count === 1 ? '' : 's'} ·{' '}
                    {formatDayLabel(c.day.date)}
                  </title>
                )}
              </rect>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

type MonthLabel = { col: number; text: string };

/**
 * Walk the day window once, recording the column where each new month
 * starts. We use the locale-short name (`Apr`, `May`, …) — toolitp
 * already gives the absolute date on hover, so the axis labels stay
 * compact. Labels closer than MIN_LABEL_GAP_COLS columns are skipped
 * to avoid text collisions where a month boundary falls within a
 * couple of weeks of another.
 */
function buildMonthLabels(days: ActivityDay[]): MonthLabel[] {
  if (days.length === 0) return [];
  const first = parseUtcDay(days[0]!.date);
  const leading = first.getUTCDay();
  const out: MonthLabel[] = [];
  let prevMonth = -1;
  for (let i = 0; i < days.length; i++) {
    const d = parseUtcDay(days[i]!.date);
    const m = d.getUTCMonth();
    if (m === prevMonth) continue;
    prevMonth = m;
    const col = Math.floor((leading + i) / 7);
    if (out.length > 0 && col - out[out.length - 1]!.col < MIN_LABEL_GAP_COLS) continue;
    out.push({
      col,
      text: d.toLocaleDateString(undefined, { month: 'short' }),
    });
  }
  return out;
}

type GridCell = {
  col: number;
  row: number;
  /** null for the leading / trailing placeholders that pad out the
   *  first / last column to a full week. */
  day: ActivityDay | null;
};

type Grid = {
  weeks: number;
  cells: GridCell[];
};

function buildGrid(days: ActivityDay[]): Grid {
  if (days.length === 0) return { weeks: 0, cells: [] };
  const first = parseUtcDay(days[0]!.date);
  const leading = first.getUTCDay(); // 0 = Sunday
  const totalRows = leading + days.length;
  const weeks = Math.ceil(totalRows / 7);

  const cells: GridCell[] = [];
  // Leading placeholders so the column starts at Sunday.
  for (let i = 0; i < leading; i++) {
    cells.push({ col: 0, row: i, day: null });
  }
  for (let i = 0; i < days.length; i++) {
    const idx = leading + i;
    cells.push({ col: Math.floor(idx / 7), row: idx % 7, day: days[i]! });
  }
  // Trailing placeholders not strictly needed — `<svg>`'s viewport
  // is sized off `weeks`, so missing rects are simply transparent.
  return { weeks, cells };
}

function parseUtcDay(iso: string): Date {
  // iso is YYYY-MM-DD; new Date(iso) parses as UTC midnight per the
  // spec. Building from parts avoids any host-TZ surprises.
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDayLabel(iso: string): string {
  const d = parseUtcDay(iso);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Buckets:
 *   0 → empty
 *   1 → exactly 1 command
 *   2 → 2–3 commands
 *   3 → 4–6 commands
 *   4 → 7+ commands
 *
 * Hand-tuned for the single-user case (most days are 0, active days
 * are typically 1–10). The scale stays meaningful even if a power
 * user sometimes hits 50 — they cap out at the brightest bucket
 * rather than washing out the rest of the grid.
 */
function bucketize(n: number): 0 | 1 | 2 | 3 | 4 {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 6) return 3;
  return 4;
}

function bucketClass(b: number): string {
  switch (b) {
    case 0:
      // Zero-day cells need to be VISIBLE — they're the grid that
      // makes the chart legible — but quiet enough not to compete
      // with the active days. surface-1 / surface-2 were too close
      // to the surrounding card bg (which is itself surface-1) and
      // the cells effectively disappeared. neutral-200 / neutral-800
      // give ~5-8% contrast against the card in their respective
      // themes — visible without shouting.
      return 'fill-neutral-200 dark:fill-neutral-800';
    case 1:
      return 'fill-emerald-200 dark:fill-emerald-900';
    case 2:
      return 'fill-emerald-400 dark:fill-emerald-700';
    case 3:
      return 'fill-emerald-500 dark:fill-emerald-500';
    case 4:
    default:
      return 'fill-emerald-600 dark:fill-emerald-300';
  }
}
