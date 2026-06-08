import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActivityDay } from '@argus/shared-types';
import { useResolvedTheme } from '../lib/theme';

type Props = {
  /** Dense, ascending-by-date list — one entry per day. */
  days: ActivityDay[];
  /** Plot height in pixels (excludes the x-axis label gutter). */
  height?: number;
};

/**
 * By-day commands line chart — the "curve" companion to
 * {@link ActivityHeatmap}. Same data, same pure-SVG / theme-aware /
 * ResizeObserver-fills-width philosophy (no charting dependency).
 *
 * Layout:
 *   - X axis spans the full day window; month boundaries get a short
 *     locale label along the bottom gutter.
 *   - Y axis is commands/day, scaled to a "nice" rounded ceiling with
 *     a midline gridline so the magnitude is readable at a glance.
 *   - The series is drawn as a smooth Catmull-Rom curve with a soft
 *     area fill underneath. Daily counts are spiky by nature; the
 *     smoothing keeps the trend legible without hiding the spikes.
 *   - Hover anywhere over the plot snaps to the nearest day, drawing a
 *     guide line + dot and a portaled tooltip (same clipping-proof
 *     trick the heatmap uses for its top-row cells).
 */
const PAD_LEFT = 30; // room for the y-axis count labels
const PAD_RIGHT = 6;
const PAD_TOP = 6;
const AXIS_H = 16; // bottom gutter for month labels

const MIN_LABEL_GAP_PX = 28; // skip month labels that would collide

export function ActivityLineChart({ days, height = 132 }: Props) {
  const theme = useResolvedTheme();
  const colors = theme === 'dark' ? DARK : LIGHT;

  const total = useMemo(() => days.reduce((m, d) => m + d.count, 0), [days]);
  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.count), 0), [days]);
  const niceMax = useMemo(() => niceCeil(max), [max]);

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

  const width = wrapWidth;
  const plotW = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const plotH = height - PAD_TOP;
  const fullH = height + AXIS_H;

  // x(i): even spacing across the window. y(count): top-down, so a
  // larger count sits higher (smaller y). niceMax guards /0.
  const n = days.length;
  const xOf = (i: number) => PAD_LEFT + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yOf = (count: number) => PAD_TOP + plotH - (count / niceMax) * plotH;

  const points = useMemo(
    () => days.map((d, i) => ({ x: xOf(i), y: yOf(d.count) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, plotW, plotH, niceMax],
  );

  const linePath = useMemo(() => smoothPath(points), [points]);
  const areaPath = useMemo(() => {
    if (points.length === 0) return '';
    const baseY = PAD_TOP + plotH;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    return `${smoothPath(points)} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`;
  }, [points, plotH]);

  const months = useMemo(() => buildMonthTicks(days), [days]);
  // useId yields colon-wrapped ids (`:r0:`) that break `url(#…)`
  // references — strip to a CSS-safe token.
  const gradientId = `actline${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (n === 0 || plotW === 0) return;
    // rect is the capture <rect>, which already starts at x=PAD_LEFT,
    // so e.clientX - rect.left is the offset within the plot area —
    // don't subtract PAD_LEFT again or the reading lags left by 30px.
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, plotW === 0 ? 0 : rel / plotW));
    const i = Math.round(frac * (n - 1));
    setHover({ i, px: xOf(i), py: yOf(days[i]!.count) });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-caps">
        {total.toLocaleString()} command{total === 1 ? '' : 's'} in the last year
        {max > 0 && <span className="text-fg-muted"> · peak {max.toLocaleString()}/day</span>}
      </div>
      {/* Reserve the plot height up front: the svg only renders once the
          ResizeObserver has a width, so without this the wrap is 0px tall
          on first paint and pops to `fullH` — which, combined with the
          heatmap being a different height, made the profile's Grid/Curve
          toggle reflow the page. */}
      <div ref={wrapRef} className="relative w-full" style={{ minHeight: fullH }}>
        {width > 0 && (
          <svg
            width={width}
            height={fullH}
            role="img"
            aria-label={`Commands per day over the last year: ${total} total, peak ${max} on a single day.`}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.line} stopOpacity={0.22} />
                <stop offset="100%" stopColor={colors.line} stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* Y gridlines + labels at 0, mid, max. */}
            {[0, niceMax / 2, niceMax].map((v) => {
              const y = yOf(v);
              return (
                <g key={v}>
                  <line
                    x1={PAD_LEFT}
                    x2={width - PAD_RIGHT}
                    y1={y}
                    y2={y}
                    stroke={colors.grid}
                    strokeWidth={1}
                  />
                  <text
                    x={PAD_LEFT - 6}
                    y={y}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-fg-tertiary"
                    fontSize={10}
                  >
                    {formatCount(v)}
                  </text>
                </g>
              );
            })}

            {/* Month labels along the bottom. */}
            {months.map((m) => (
              <text
                key={m.i}
                x={xOf(m.i)}
                y={fullH - 4}
                className="fill-fg-tertiary"
                fontSize={10}
              >
                {m.text}
              </text>
            ))}

            {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
            {linePath && (
              <path
                d={linePath}
                fill="none"
                stroke={colors.line}
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}

            {hover && (
              <g>
                <line
                  x1={hover.px}
                  x2={hover.px}
                  y1={PAD_TOP}
                  y2={PAD_TOP + plotH}
                  stroke={colors.grid}
                  strokeWidth={1}
                />
                <circle cx={hover.px} cy={hover.py} r={3} fill={colors.line} />
              </g>
            )}

            {/* Transparent capture layer for hover. */}
            <rect
              x={PAD_LEFT}
              y={PAD_TOP}
              width={plotW}
              height={plotH}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            />
          </svg>
        )}
        {hover && wrapRef.current && (
          <HoverTooltip wrapEl={wrapRef.current} px={hover.px} py={hover.py} day={days[hover.i]!} />
        )}
      </div>
    </div>
  );
}

/**
 * Floating tooltip portaled into <body> with viewport-fixed coords so
 * the surrounding scroll/overflow contexts can't clip it. We derive
 * the viewport position from the wrapper's BoundingClientRect plus the
 * point's SVG-local (px, py).
 */
function HoverTooltip({
  wrapEl,
  px,
  py,
  day,
}: {
  wrapEl: HTMLElement;
  px: number;
  py: number;
  day: ActivityDay;
}) {
  const r = wrapEl.getBoundingClientRect();
  return createPortal(
    <div
      className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-default bg-surface-1 px-2 py-1 text-xs text-fg-primary shadow-md"
      style={{ left: r.left + px, top: r.top + py - 8 }}
    >
      <span className="font-medium">{day.count}</span>
      <span className="text-fg-tertiary"> command{day.count === 1 ? '' : 's'}</span>
      <span className="text-fg-tertiary"> · </span>
      <span>{formatDayLabel(day.date)}</span>
    </div>,
    document.body,
  );
}

type MonthTick = { i: number; text: string };

/**
 * Index of the first day of each month, labelled with the locale-short
 * month name. Ticks closer than MIN_LABEL_GAP_PX (estimated from the
 * day count and a nominal 600 px width) are skipped to avoid overlap;
 * the real skip is recomputed visually but this keeps the common case
 * clean without a width round-trip.
 */
function buildMonthTicks(days: ActivityDay[]): MonthTick[] {
  if (days.length === 0) return [];
  const out: MonthTick[] = [];
  let prevMonth = -1;
  let prevI = -Infinity;
  // Approximate columns-per-pixel using a nominal width; daily charts
  // are wide enough that a per-month label every ~30 days reads fine.
  const minGapDays = Math.max(1, Math.round((MIN_LABEL_GAP_PX / 600) * days.length));
  for (let i = 0; i < days.length; i++) {
    const d = parseUtcDay(days[i]!.date);
    const m = d.getUTCMonth();
    if (m === prevMonth) continue;
    prevMonth = m;
    if (i - prevI < minGapDays) continue;
    prevI = i;
    out.push({ i, text: d.toLocaleDateString(undefined, { month: 'short' }) });
  }
  return out;
}

/**
 * Catmull-Rom → cubic-bezier smoothing. Produces a path that passes
 * through every point with C1 continuity, so the line stays faithful
 * to the data (it doesn't overshoot like a loose spline) while reading
 * as a curve rather than a polyline.
 */
function smoothPath(pts: ReadonlyArray<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

/** Smallest "nice" ceiling (1/2/5 × 10ⁿ) at or above n, min 1. */
function niceCeil(n: number): number {
  if (n <= 1) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * base;
    if (candidate >= n) return candidate;
  }
  return 10 * base;
}

function formatCount(n: number): string {
  const r = Math.round(n);
  if (r >= 1000) return `${(r / 1000).toFixed(r % 1000 === 0 ? 0 : 1)}k`;
  return String(r);
}

function parseUtcDay(iso: string): Date {
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

// Baked hex (mirrors ActivityHeatmap's rationale: Tailwind didn't
// reliably emit `stroke-emerald-*` utilities in this build, so SVG
// strokes use literals). Emerald-500 line on both themes; the grid
// line matches each theme's zero-day cell color.
const LIGHT = { line: '#10b981', grid: '#e5e5e5' } as const;
const DARK = { line: '#34d399', grid: '#262626' } as const;
