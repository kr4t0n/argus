import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PixelProject, PixelsResponse } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Command statuses that mean the turn is over. Mirrors
 *  `TERMINAL_COMMAND_STATUSES` in session.service.ts — duplicated rather
 *  than imported to keep this read-only view free of a dependency on the
 *  dispatch path. */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/** Winner share below which a slot is considered contested and gets an
 *  entry in the optional `breakdown` map. */
const CONTESTED_THRESHOLD = 0.7;

export interface PixelGridOptions {
  /** IANA zone slots are bucketed in. Validated by the controller. */
  tz: string;
  /** Number of LOCAL days the grid covers, ending with today. */
  days: number;
  slotMinutes: number;
  /**
   * Maximum seconds a single turn may contribute, in minutes.
   *
   * This is not defensive trimming — it materially changes the picture.
   * Turn durations are heavily skewed (measured on a real corpus: p50
   * 2.4 min, p90 14 min, p99 44 min, max 19.2 HOURS), and the tail is
   * idle time, not work: a CLI left open overnight finalizes normally
   * hours later. Unclamped, a single 19-hour turn contributed ~8% of the
   * grid's total ink and promoted its project from a clear #2 to a
   * near-tie for #1 — i.e. the clamp decides which project the wall says
   * you spent your time on.
   *
   * 60 is the default because it touches only the outliers: on the same
   * corpus, exactly 17 of 3,160 turns (0.5%) exceeded an hour.
   *
   * It also bounds the open-ended case — a turn with a NULL
   * `completedAt` (never finalized) would otherwise run to `now()` and
   * smear its colour across every slot since it started.
   */
  clampMinutes: number;
  /** Include the sparse per-slot split for contested slots. */
  breakdown: boolean;
}

type SlotRow = { slot_idx: number; project_id: string; secs: number };
type LiveRow = { project_id: string };

@Injectable()
export class PixelsService {
  constructor(private readonly prisma: PrismaService) {}

  async grid(userId: string, opts: PixelGridOptions): Promise<PixelsResponse> {
    const slotSecs = opts.slotMinutes * 60;
    const slotCount = Math.ceil((opts.days * 24 * 60) / opts.slotMinutes);

    const [rows, live, startUtc] = await Promise.all([
      this.slotRows(userId, opts, slotSecs, slotCount),
      this.liveProjectIds(userId, opts.clampMinutes),
      this.gridStart(opts.tz, opts.days),
    ]);

    return assemble(rows, live, {
      startUtc,
      slotCount,
      slotMinutes: opts.slotMinutes,
      tz: opts.tz,
      breakdown: opts.breakdown,
    });
  }

  /**
   * Per (slot, project) busy seconds.
   *
   * Shape of the computation, and why it is this way:
   *
   *  - Each command becomes a half-open interval [createdAt, end), where
   *    `end` is the earliest of its completion, its clamp, and now.
   *  - The interval is converted to LOCAL wall-clock time and expressed
   *    as seconds since the grid origin, then split across the integer
   *    slot indices it touches. Slot indices are generated arithmetically
   *    (`generate_series` over ints) rather than as a timestamp series,
   *    so any `slotMinutes` works and the [0, slotCount) clamp is free.
   *  - Cost scales with commands × slots-each-spans, NOT with grid size.
   *    Widening the window to a year costs the same per command; only the
   *    number of commands in range matters.
   *
   * The `createdAt >= t0 - clamp` predicate is what keeps this off a full
   * table scan: a command can only reach the grid if it started at most
   * one clamp-width before the origin.
   *
   * Timestamps are `timestamp without time zone` holding UTC (Prisma's
   * default mapping), hence the `AT TIME ZONE 'UTC' AT TIME ZONE tz`
   * two-step. Reversing it rotates the entire grid by the UTC offset,
   * silently and plausibly.
   */
  private slotRows(
    userId: string,
    opts: PixelGridOptions,
    slotSecs: number,
    slotCount: number,
  ): Promise<SlotRow[]> {
    return this.prisma.$queryRaw<SlotRow[]>`
      WITH b AS (
        SELECT (now() AT TIME ZONE 'UTC') AS now_utc,
               (date_trunc('day', now() AT TIME ZONE ${opts.tz})
                  - make_interval(days => ${opts.days - 1}::int)) AS t0_local
      ),
      bb AS (
        SELECT b.now_utc, b.t0_local,
               (b.t0_local AT TIME ZONE ${opts.tz}) AT TIME ZONE 'UTC' AS t0_utc
        FROM b
      ),
      spans AS (
        SELECT s."projectId" AS project_id,
               c."createdAt"  AS s_start,
               LEAST(
                 COALESCE(c."completedAt", bb.now_utc),
                 c."createdAt" + make_interval(mins => ${opts.clampMinutes}::int),
                 bb.now_utc
               ) AS s_end,
               bb.t0_local
        FROM "Command" c
        JOIN "Session" s ON s.id = c."sessionId"
        CROSS JOIN bb
        WHERE s."userId" = ${userId}
          AND s."projectId" IS NOT NULL
          AND c."createdAt" <  bb.now_utc
          AND c."createdAt" >= bb.t0_utc - make_interval(mins => ${opts.clampMinutes}::int)
      ),
      rel AS (
        SELECT project_id,
               EXTRACT(epoch FROM
                 ((s_start AT TIME ZONE 'UTC' AT TIME ZONE ${opts.tz}) - t0_local))::float8 AS a,
               EXTRACT(epoch FROM
                 ((s_end   AT TIME ZONE 'UTC' AT TIME ZONE ${opts.tz}) - t0_local))::float8 AS z
        FROM spans
        WHERE s_end > s_start
      )
      SELECT i AS slot_idx,
             project_id,
             sum(
               LEAST(z, (i + 1)::float8 * ${slotSecs}::float8)
             - GREATEST(a, i::float8 * ${slotSecs}::float8)
             )::float8 AS secs
      FROM rel
      CROSS JOIN LATERAL generate_series(
        GREATEST(0, floor(a / ${slotSecs}::float8)::int),
        LEAST(${slotCount - 1}::int, ceil(z / ${slotSecs}::float8)::int - 1)
      ) AS i
      GROUP BY 1, 2
      HAVING sum(
               LEAST(z, (i + 1)::float8 * ${slotSecs}::float8)
             - GREATEST(a, i::float8 * ${slotSecs}::float8)
             ) > 0
      ORDER BY 1, 2
    `;
  }

  /**
   * Projects with a turn in flight right now — the blink set.
   *
   * Keyed on `Command.status`, deliberately NOT `Session.status`. The
   * session flag is a denormalized projection with a documented drift
   * mode: a chunk arriving after its own turn finalized used to re-mark
   * the session `active` with nothing left to clear it, and sessions were
   * found stuck that way for over a month (see the repair migration
   * `20260827120000_repair_stuck_active_sessions`, whose own ground truth
   * was this same predicate).
   *
   * Bounded by the clamp for the same reason the grid is: without it, one
   * turn that never finalizes blinks the wall forever.
   */
  private async liveProjectIds(userId: string, clampMinutes: number): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<LiveRow[]>`
      SELECT DISTINCT s."projectId" AS project_id
      FROM "Command" c
      JOIN "Session" s ON s.id = c."sessionId"
      WHERE s."userId" = ${userId}
        AND s."projectId" IS NOT NULL
        AND c.status <> ALL (${TERMINAL_STATUSES})
        AND c."createdAt" >= (now() AT TIME ZONE 'UTC')
                             - make_interval(mins => ${clampMinutes}::int)
    `;
    return new Set(rows.map((r) => r.project_id));
  }

  /** UTC instant of slot 0 — local midnight, `days - 1` days back.
   *  Computed in Postgres so it can't disagree with the bucketing. */
  private async gridStart(tz: string, days: number): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ t0: Date }[]>`
      SELECT ((date_trunc('day', now() AT TIME ZONE ${tz})
                 - make_interval(days => ${days - 1}::int)) AT TIME ZONE ${tz}) AS t0
    `;
    return rows[0].t0;
  }
}

/** Stable 8-hex-char key. Lets a payload identify a project without
 *  carrying its absolute `workingDir`, which is a filesystem path and
 *  has no business on a page the project doesn't control. */
function projectKey(projectId: string): string {
  return createHash('sha256').update(projectId).digest('hex').slice(0, 8);
}

interface AssembleOptions {
  startUtc: Date;
  slotCount: number;
  slotMinutes: number;
  tz: string;
  breakdown: boolean;
}

/**
 * Turn (slot, project) seconds into the columnar wire shape.
 *
 * Emits EVERY project that took a slot, ranked by seconds won. Collapsing
 * a tail into an "other" swatch is a rendering decision and is left to
 * the client — which can just take the first N, since the ranking is the
 * part that is actually data.
 */
function assemble(
  rows: SlotRow[],
  liveIds: Set<string>,
  opts: AssembleOptions,
): PixelsResponse {
  const bySlot = new Map<number, Map<string, number>>();
  for (const r of rows) {
    if (r.slot_idx < 0 || r.slot_idx >= opts.slotCount) continue;
    let m = bySlot.get(r.slot_idx);
    if (!m) bySlot.set(r.slot_idx, (m = new Map()));
    m.set(r.project_id, (m.get(r.project_id) ?? 0) + r.secs);
  }

  // Winner per slot, plus the totals that drive ranking and brightness.
  const winnerOf = new Map<number, string>();
  const totalOf = new Map<number, number>();
  const wonSeconds = new Map<string, number>();
  for (const [slot, m] of bySlot) {
    let bestId = '';
    let bestSecs = -1;
    let total = 0;
    for (const [pid, secs] of m) {
      total += secs;
      // Ties break on project id so the wall is deterministic across
      // requests rather than following Map insertion order.
      if (secs > bestSecs || (secs === bestSecs && pid < bestId)) {
        bestSecs = secs;
        bestId = pid;
      }
    }
    winnerOf.set(slot, bestId);
    totalOf.set(slot, total);
    wonSeconds.set(bestId, (wonSeconds.get(bestId) ?? 0) + bestSecs);
  }

  // A project can be live without having won a slot — its turn may be
  // losing the current hour to another project. Listing it with zero
  // ensures every `live` index resolves; otherwise it would be filtered
  // out below and the wall would sit still while something is
  // demonstrably running.
  for (const pid of liveIds) {
    if (!wonSeconds.has(pid)) wonSeconds.set(pid, 0);
  }

  // Ties break on project id so the ranking is stable across requests
  // rather than following Map insertion order.
  const ranked = [...wonSeconds.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const projects: PixelProject[] = ranked.map(([pid, secs]) => ({
    key: projectKey(pid),
    wonSeconds: Math.round(secs),
  }));
  const indexOf = new Map<string, number>(ranked.map(([pid], i) => [pid, i]));

  const maxTotal = Math.max(0, ...totalOf.values());
  const winners: (number | null)[] = new Array(opts.slotCount).fill(null);
  const intensity: number[] = new Array(opts.slotCount).fill(0);
  const breakdown: Record<string, Record<string, number>> = {};

  for (let i = 0; i < opts.slotCount; i++) {
    const w = winnerOf.get(i);
    if (w === undefined) continue;
    winners[i] = indexOf.get(w) ?? null;
    const total = totalOf.get(i) ?? 0;
    // Brightness tracks the slot's TOTAL busy time, not the winner's
    // share: the winner answers "who owned this hour", brightness "how
    // busy was it". Measured on a real corpus, ~30% of lit slots have no
    // dominant project, so folding the two into one channel would render
    // a packed contested hour dimmer than a quiet uncontested one.
    intensity[i] = maxTotal > 0 ? Math.round((total / maxTotal) * 100) : 0;

    if (opts.breakdown && total > 0) {
      const winnerSecs = bySlot.get(i)?.get(w) ?? 0;
      if (winnerSecs / total < CONTESTED_THRESHOLD) {
        const split: Record<string, number> = {};
        for (const [pid, secs] of bySlot.get(i)!) {
          const idx = indexOf.get(pid);
          if (idx === undefined) continue;
          split[idx] = (split[idx] ?? 0) + Math.round(secs);
        }
        breakdown[i] = split;
      }
    }
  }

  const live = [
    ...new Set(
      [...liveIds].map((pid) => indexOf.get(pid)).filter((i): i is number => i !== undefined),
    ),
  ].sort((a, b) => a - b);

  return {
    start: opts.startUtc.toISOString(),
    slotMinutes: opts.slotMinutes,
    slotCount: opts.slotCount,
    tz: opts.tz,
    winners,
    intensity,
    ...(opts.breakdown && Object.keys(breakdown).length > 0 ? { breakdown } : {}),
    projects,
    live,
  };
}
