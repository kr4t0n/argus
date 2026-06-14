import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AgentType,
  ProjectNotesResponse,
  QuotaWindow,
  TokenUsage,
  UserActivityResponse,
  UserExtensionsResponse,
  UserQuotaResponse,
  UserQuotaRow,
  UserRulesResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { PROJECT_NOTES_MAX_BYTES, USER_RULES_MAX_BYTES } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { MachineService } from '../machine/machine.service';

const DAY_MS = 86_400_000;

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly machines: MachineService,
  ) {}

  /**
   * Per-day command count for the user's last `windowDays` (default
   * 365), shaped for a GitHub-style activity grid. The window is
   * anchored to today UTC and includes zero-days so the heatmap can
   * render contiguous columns without client-side gap-filling.
   *
   * We count Commands (not Sessions) because they map to a single
   * user-driven prompt — the granular unit of "I did something with
   * an agent today." Cancellations + executes both count; that's the
   * activity signal, not just successful runs.
   */
  async activity(userId: string, windowDays = 365): Promise<UserActivityResponse> {
    const today = startOfUtcDay(new Date());
    const start = new Date(today.getTime() - (windowDays - 1) * DAY_MS);

    // groupBy in Prisma can't truncate a timestamp to a day — fall back
    // to raw SQL. Postgres' `date_trunc('day', ...)` returns a
    // timestamp at midnight UTC, which we format ISO-day-stringified
    // on the way out. The where clause restricts to commands belonging
    // to sessions owned by this user.
    type Row = { day: Date; count: bigint };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT date_trunc('day', c."createdAt") AS day,
             COUNT(*)                          AS count
      FROM   "Command" c
      JOIN   "Session" s ON s.id = c."sessionId"
      WHERE  s."userId" = ${userId}
        AND  c."createdAt" >= ${start}
      GROUP  BY day
      ORDER  BY day ASC
    `;

    // Index counts by ISO day for O(1) lookup while we iterate the
    // window day-by-day filling zero-days.
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(toIsoDay(r.day), Number(r.count));
    }

    const days = [];
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(start.getTime() + i * DAY_MS);
      const iso = toIsoDay(d);
      days.push({ date: iso, count: counts.get(iso) ?? 0 });
    }
    return { days };
  }

  /**
   * Aggregate token usage across every session the user owns, bucketed
   * into rolling 7-/30-day windows plus the all-time lifetime total.
   *
   * Reads the denormalized `Command.usage` JSONB written by the
   * result-ingestor when each turn finalizes — `parseUsage` runs once
   * at write time, the read path SUMs numerics in Postgres.
   *
   * One scan, three windows: lifetime is the unfiltered SUM; the
   * rolling buckets are the same SUM wrapped in a FILTER on
   * `Command.createdAt` (the column already carried by
   * `@@index([sessionId, createdAt])`, matching how `activity()`
   * windows). Conditional aggregation keeps it a single round trip
   * instead of three near-identical scans. Windows are now-anchored,
   * not calendar-aligned — "last 7 days" is the trailing 7×24h.
   *
   * The SUMs are over `(c.usage->>'<field>')::numeric` casts, which
   * skip NULL rows automatically. `costUsd` and `durationApiMs` are
   * optional in the stored shape; per window we only attach them if at
   * least one row *in that window* carried them — matches `sumUsage`'s
   * undefined-vs-zero semantics so a recent codex-only stretch doesn't
   * show a spurious "$0.00" even when the lifetime total has a cost.
   *
   * If commands predating the denormalization haven't been backfilled
   * yet (`Command.usage IS NULL` on completed rows), they're silently
   * excluded. Run `pnpm -F @argus/server backfill:usage` to populate.
   */
  async usage(userId: string): Promise<UserUsageResponse> {
    type Row = {
      all_input: string | null;
      all_output: string | null;
      all_cread: string | null;
      all_cwrite: string | null;
      all_cost: string | null;
      all_apims: string | null;
      all_cost_rows: bigint;
      all_apims_rows: bigint;
      d30_input: string | null;
      d30_output: string | null;
      d30_cread: string | null;
      d30_cwrite: string | null;
      d30_cost: string | null;
      d30_apims: string | null;
      d30_cost_rows: bigint;
      d30_apims_rows: bigint;
      d7_input: string | null;
      d7_output: string | null;
      d7_cread: string | null;
      d7_cwrite: string | null;
      d7_cost: string | null;
      d7_apims: string | null;
      d7_cost_rows: bigint;
      d7_apims_rows: bigint;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        SUM((c.usage->>'inputTokens')::numeric)        AS all_input,
        SUM((c.usage->>'outputTokens')::numeric)       AS all_output,
        SUM((c.usage->>'cacheReadTokens')::numeric)    AS all_cread,
        SUM((c.usage->>'cacheWriteTokens')::numeric)   AS all_cwrite,
        SUM((c.usage->>'costUsd')::numeric)            AS all_cost,
        SUM((c.usage->>'durationApiMs')::numeric)      AS all_apims,
        COUNT(*) FILTER (WHERE c.usage ? 'costUsd')        AS all_cost_rows,
        COUNT(*) FILTER (WHERE c.usage ? 'durationApiMs')  AS all_apims_rows,

        SUM((c.usage->>'inputTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '30 days')   AS d30_input,
        SUM((c.usage->>'outputTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '30 days')   AS d30_output,
        SUM((c.usage->>'cacheReadTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '30 days')   AS d30_cread,
        SUM((c.usage->>'cacheWriteTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '30 days')   AS d30_cwrite,
        SUM((c.usage->>'costUsd')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '30 days')   AS d30_cost,
        SUM((c.usage->>'durationApiMs')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '30 days')   AS d30_apims,
        COUNT(*) FILTER (WHERE c.usage ? 'costUsd'
          AND c."createdAt" >= NOW() - INTERVAL '30 days')             AS d30_cost_rows,
        COUNT(*) FILTER (WHERE c.usage ? 'durationApiMs'
          AND c."createdAt" >= NOW() - INTERVAL '30 days')             AS d30_apims_rows,

        SUM((c.usage->>'inputTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '7 days')    AS d7_input,
        SUM((c.usage->>'outputTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '7 days')    AS d7_output,
        SUM((c.usage->>'cacheReadTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '7 days')    AS d7_cread,
        SUM((c.usage->>'cacheWriteTokens')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '7 days')    AS d7_cwrite,
        SUM((c.usage->>'costUsd')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '7 days')    AS d7_cost,
        SUM((c.usage->>'durationApiMs')::numeric)
          FILTER (WHERE c."createdAt" >= NOW() - INTERVAL '7 days')    AS d7_apims,
        COUNT(*) FILTER (WHERE c.usage ? 'costUsd'
          AND c."createdAt" >= NOW() - INTERVAL '7 days')              AS d7_cost_rows,
        COUNT(*) FILTER (WHERE c.usage ? 'durationApiMs'
          AND c."createdAt" >= NOW() - INTERVAL '7 days')              AS d7_apims_rows
      FROM   "Command"  c
      JOIN   "Session"  s ON s.id = c."sessionId"
      WHERE  s."userId" = ${userId}
        AND  c.usage IS NOT NULL
    `;
    const r = rows[0];
    return {
      usage: {
        lifetime: windowUsage(
          r?.all_input,
          r?.all_output,
          r?.all_cread,
          r?.all_cwrite,
          r?.all_cost,
          r?.all_apims,
          r?.all_cost_rows,
          r?.all_apims_rows,
        ),
        last30Days: windowUsage(
          r?.d30_input,
          r?.d30_output,
          r?.d30_cread,
          r?.d30_cwrite,
          r?.d30_cost,
          r?.d30_apims,
          r?.d30_cost_rows,
          r?.d30_apims_rows,
        ),
        last7Days: windowUsage(
          r?.d7_input,
          r?.d7_output,
          r?.d7_cread,
          r?.d7_cwrite,
          r?.d7_cost,
          r?.d7_apims,
          r?.d7_cost_rows,
          r?.d7_apims_rows,
        ),
      },
    };
  }

  /**
   * Latest plan-quota snapshot per CLI / per signed-in account, picked
   * across the user's entire fleet of sidecars.
   *
   * Aggregation is two-step:
   *   1. Group rows by (agentType, fingerprint). For each group, the
   *      sidecar's freshest `checkedAt` wins — same Anthropic/ChatGPT
   *      /Cursor account reported from three different boxes
   *      collapses to one row, attributed to whichever box reported
   *      most recently.
   *   2. Drop tombstone groups (fingerprint = ''). They only exist
   *      so a sidecar can clear a previously-good row when the user
   *      logs out on that machine; once aggregated, an agentType with
   *      nothing but tombstones means the user isn't signed in
   *      anywhere, and the row should disappear entirely rather than
   *      surface as "not signed in" — the empty-list hint on the web
   *      UI tells the user how to sign in.
   *
   * Userland filtering is not applied — Argus is single-tenant per
   * deployment and every user already sees every machine via the
   * machine list. If we ever flip that, this query needs to scope to
   * machines the user has agents on.
   */
  async quota(_userId: string): Promise<UserQuotaResponse> {
    const rows = await this.prisma.machineAgentQuota.findMany({
      orderBy: { checkedAt: 'desc' },
      include: { machine: { select: { id: true, name: true } } },
    });

    // Step 1: per (agentType, fingerprint), keep the freshest row.
    // checkedAt-desc order means first-seen wins.
    type Row = (typeof rows)[number];
    const freshest = new Map<string, Row>();
    for (const r of rows) {
      const key = `${r.agentType}\x00${r.fingerprint}`;
      if (!freshest.has(key)) freshest.set(key, r);
    }

    // Step 2: emit one row per real account, dropping tombstones.
    // Sort by (agentType, machineName, fingerprint) so the panel's row
    // order is stable across refreshes — without this, the response
    // followed `checkedAt desc` and shuffled every time a sidecar's
    // 5-min probe re-cached. fingerprint is the final tiebreaker so
    // two boxes with the same name still order deterministically.
    const surviving = [...freshest.values()].filter((r) => r.fingerprint !== '');
    surviving.sort(
      (a, b) =>
        a.agentType.localeCompare(b.agentType) ||
        a.machine.name.localeCompare(b.machine.name) ||
        a.fingerprint.localeCompare(b.fingerprint),
    );
    return { quotas: surviving.map(toQuotaRow) };
  }

  /**
   * Free-form rules the user wants every CLI agent they spawn to
   * follow. Stored in `User.rules`; NULL becomes empty string in the
   * response so the client doesn't have to disambiguate "never set"
   * from "explicitly cleared."
   */
  async getRules(userId: string): Promise<UserRulesResponse> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { rules: true },
    });
    if (!row) throw new NotFoundException('user not found');
    return { rules: row.rules ?? '' };
  }

  /**
   * Persist rules text. Hard-caps at USER_RULES_MAX_BYTES so a
   * runaway paste can't blow up the row; the byte length is measured
   * via TextEncoder so multi-byte characters count correctly. Empty
   * string is allowed and stored as NULL — that gives a future
   * "clear rules" gesture a target without juggling a sentinel.
   *
   * After persistence we fan the (potentially-empty) rules text out
   * to every online sidecar via `sync-user-rules` so each one
   * rewrites the global CLI rules files (CLAUDE.md / AGENTS.md).
   * The fanout is best-effort — if a publish fails we log and move
   * on; Postgres remains authoritative and the user can re-Save.
   */
  async setRules(userId: string, rules: string): Promise<UserRulesResponse> {
    const bytes = new TextEncoder().encode(rules).byteLength;
    if (bytes > USER_RULES_MAX_BYTES) {
      throw new BadRequestException(
        `rules too large: ${bytes} bytes > ${USER_RULES_MAX_BYTES} byte limit`,
      );
    }
    const next = rules.length === 0 ? null : rules;
    const updated = await this.prisma.user
      .update({
        where: { id: userId },
        data: { rules: next },
        select: { rules: true },
      })
      .catch((err) => {
        // P2025 = "Record to update not found" — surface as 404 so
        // a deleted-mid-flight user gets a meaningful response.
        if ((err as { code?: string }).code === 'P2025') {
          throw new NotFoundException('user not found');
        }
        throw err;
      });

    const synced = updated.rules ?? '';
    this.machines.syncUserRulesAll(synced).catch((err) => {
      this.logger.error(`sync-user-rules fanout failed: ${(err as Error).message}`);
    });

    return { rules: synced };
  }

  /**
   * Free-form notes the user keeps for a project — the
   * `(machineId, workingDir)` pair every session in that directory
   * shares. Missing row → empty string so the client doesn't have to
   * disambiguate "never written" from "explicitly cleared." Unlike
   * rules these are personal scratch and are never synced to sidecars.
   */
  async getProjectNotes(
    userId: string,
    machineId: string,
    workingDir: string,
  ): Promise<ProjectNotesResponse> {
    const row = await this.prisma.projectNote.findUnique({
      where: { userId_machineId_workingDir: { userId, machineId, workingDir } },
      select: { notes: true },
    });
    return { notes: row?.notes ?? '' };
  }

  /**
   * Persist project notes. Hard-caps at PROJECT_NOTES_MAX_BYTES via
   * TextEncoder so multi-byte characters count correctly. An empty
   * string deletes the row — there's no "no notes" sentinel to keep,
   * and a missing row already reads back as "". Otherwise upserts so
   * the first save creates the row and later saves overwrite it.
   */
  async setProjectNotes(
    userId: string,
    machineId: string,
    workingDir: string,
    notes: string,
  ): Promise<ProjectNotesResponse> {
    const bytes = new TextEncoder().encode(notes).byteLength;
    if (bytes > PROJECT_NOTES_MAX_BYTES) {
      throw new BadRequestException(
        `notes too large: ${bytes} bytes > ${PROJECT_NOTES_MAX_BYTES} byte limit`,
      );
    }

    const key = { userId_machineId_workingDir: { userId, machineId, workingDir } };
    if (notes.length === 0) {
      // deleteMany (not delete) so clearing a never-saved note is a
      // no-op rather than a P2025 throw.
      await this.prisma.projectNote.deleteMany({ where: { userId, machineId, workingDir } });
      return { notes: '' };
    }

    const row = await this.prisma.projectNote.upsert({
      where: key,
      create: { userId, machineId, workingDir, notes },
      update: { notes },
      select: { notes: true },
    });
    return { notes: row.notes };
  }

  /**
   * Which opt-in extensions the user has enabled. An account-level
   * preference (synced across browsers), stored as a JSON map so new
   * extensions don't need a migration. Any missing/non-boolean key
   * reads as `false`, so a never-set or partial blob is safe.
   */
  async getExtensions(userId: string): Promise<UserExtensionsResponse> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { extensions: true },
    });
    if (!row) throw new NotFoundException('user not found');
    return coerceExtensions(row.extensions);
  }

  /**
   * Replace the user's stored extension flags with the given set. The
   * client always sends the full known set, so a straight overwrite
   * keeps DB and client in agreement without read-modify-write races.
   */
  async setExtensions(
    userId: string,
    next: UserExtensionsResponse,
  ): Promise<UserExtensionsResponse> {
    const updated = await this.prisma.user
      .update({
        where: { id: userId },
        data: { extensions: { notes: next.notes, progress: next.progress, diff: next.diff } },
        select: { extensions: true },
      })
      .catch((err) => {
        if ((err as { code?: string }).code === 'P2025') {
          throw new NotFoundException('user not found');
        }
        throw err;
      });
    return coerceExtensions(updated.extensions);
  }
}

/** Normalize the stored `User.extensions` JSON (which may be null, a
 *  partial object, or — defensively — any JSON) into the typed flag
 *  set, defaulting every unknown/missing key to `false`. */
function coerceExtensions(raw: unknown): UserExtensionsResponse {
  const map = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    notes: map.notes === true,
    progress: map.progress === true,
    diff: map.diff === true,
  };
}

type QuotaRowWithMachine = {
  agentType: string;
  source: string;
  fingerprint: string;
  windows: unknown;
  error: string | null;
  checkedAt: Date;
  machine: { id: string; name: string };
};

function toQuotaRow(r: QuotaRowWithMachine): UserQuotaRow {
  return {
    type: r.agentType as AgentType,
    source: r.source as UserQuotaRow['source'],
    windows: ((r.windows ?? []) as unknown as QuotaWindow[]) ?? [],
    error: r.error ?? undefined,
    checkedAt: r.checkedAt.toISOString(),
    machineId: r.machine.id,
    machineName: r.machine.name,
  };
}

function numOrZero(v: string | null | undefined): number {
  // pg returns NUMERIC SUMs as strings to preserve precision; for token
  // counts and millisecond durations a JS number is plenty wide. NULL
  // happens when no rows matched (or the column was NULL on every row).
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Assemble one window's `TokenUsage` from its raw SUM/COUNT columns.
 * `costUsd` / `durationApiMs` are attached only when this window had
 * at least one row carrying them (`*_rows > 0`), keeping the
 * undefined-vs-zero contract per window — `undefined` rows arrive when
 * the aggregate matched nothing (empty user / empty window).
 */
function windowUsage(
  input: string | null | undefined,
  output: string | null | undefined,
  cacheRead: string | null | undefined,
  cacheWrite: string | null | undefined,
  cost: string | null | undefined,
  apiMs: string | null | undefined,
  costRows: bigint | undefined,
  apiMsRows: bigint | undefined,
): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: numOrZero(input),
    outputTokens: numOrZero(output),
    cacheReadTokens: numOrZero(cacheRead),
    cacheWriteTokens: numOrZero(cacheWrite),
  };
  if ((costRows ?? 0n) > 0n) usage.costUsd = numOrZero(cost);
  if ((apiMsRows ?? 0n) > 0n) usage.durationApiMs = numOrZero(apiMs);
  return usage;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toIsoDay(d: Date): string {
  // YYYY-MM-DD in UTC, regardless of the host's local TZ.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
