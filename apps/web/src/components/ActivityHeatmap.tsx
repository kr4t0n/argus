import { useMemo } from 'react';
import type { ActivityDay } from '@argus/shared-types';
import { cn } from '../lib/utils';

type Props = {
  /** Dense, ascending-by-date list. The first day's day-of-week
   *  determines where in the leading column the run starts (the
   *  preceding cells are rendered as empty placeholders). */
  days: ActivityDay[];
  /** Side of each square in pixels. Default 11 matches GitHub's
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
export function ActivityHeatmap({ days, cell = 11, gap = 2 }: Props) {
  const grid = useMemo(() => buildGrid(days), [days]);
  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.count), 0), [days]);
  const total = useMemo(() => days.reduce((m, d) => m + d.count, 0), [days]);

  const width = grid.weeks * cell + (grid.weeks - 1) * gap;
  const height = 7 * cell + 6 * gap;

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
      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Activity heatmap: ${total} commands in the last year, peak ${max} on a single day.`}
        >
          {grid.cells.map((c) => (
            <rect
              key={`${c.col}-${c.row}`}
              x={c.col * (cell + gap)}
              y={c.row * (cell + gap)}
              width={cell}
              height={cell}
              rx={2}
              ry={2}
              className={c.day ? bucketClass(bucketize(c.day.count)) : ''}
              fill={c.day ? undefined : 'transparent'}
            >
              {c.day && (
                <title>
                  {c.day.count} command{c.day.count === 1 ? '' : 's'} · {formatDayLabel(c.day.date)}
                </title>
              )}
            </rect>
          ))}
        </svg>
      </div>
    </div>
  );
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
      // Empty cells use surface-2 in light, dimmer in dark — same
      // contrast against the page in either theme.
      return 'fill-surface-2 dark:fill-surface-1';
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
