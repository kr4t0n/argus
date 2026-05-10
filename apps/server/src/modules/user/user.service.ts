import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AgentType,
  QuotaWindow,
  TokenUsage,
  UserActivityResponse,
  UserQuotaResponse,
  UserQuotaRow,
  UserRulesResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { USER_RULES_MAX_BYTES } from '@argus/shared-types';
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
   * Aggregate token usage across every session the user owns.
   *
   * Reads the denormalized `Command.usage` JSONB written by the
   * result-ingestor when each turn finalizes — `parseUsage` runs once
   * at write time, the read path SUMs four numerics in Postgres.
   *
   * The SUMs are over `(c.usage->>'<field>')::numeric` casts, which
   * skip NULL rows automatically. `costUsd` and `durationApiMs` are
   * optional in the stored shape; we only attach them to the response
   * if at least one row carried them — matches `sumUsage`'s
   * undefined-vs-zero semantics so codex-only users don't see a
   * spurious "$0.00" cost line.
   *
   * If commands predating the denormalization haven't been backfilled
   * yet (`Command.usage IS NULL` on completed rows), they're silently
   * excluded. Run `pnpm -F @argus/server backfill:usage` to populate.
   */
  async usage(userId: string): Promise<UserUsageResponse> {
    type Row = {
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_write_tokens: string | null;
      cost_usd: string | null;
      api_ms: string | null;
      cost_rows: bigint;
      api_ms_rows: bigint;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT
        SUM((c.usage->>'inputTokens')::numeric)        AS input_tokens,
        SUM((c.usage->>'outputTokens')::numeric)       AS output_tokens,
        SUM((c.usage->>'cacheReadTokens')::numeric)    AS cache_read_tokens,
        SUM((c.usage->>'cacheWriteTokens')::numeric)   AS cache_write_tokens,
        SUM((c.usage->>'costUsd')::numeric)            AS cost_usd,
        SUM((c.usage->>'durationApiMs')::numeric)      AS api_ms,
        COUNT(*) FILTER (WHERE c.usage ? 'costUsd')        AS cost_rows,
        COUNT(*) FILTER (WHERE c.usage ? 'durationApiMs')  AS api_ms_rows
      FROM   "Command"  c
      JOIN   "Session"  s ON s.id = c."sessionId"
      WHERE  s."userId" = ${userId}
        AND  c.usage IS NOT NULL
    `;
    const r = rows[0];
    const total: TokenUsage = {
      inputTokens: numOrZero(r?.input_tokens),
      outputTokens: numOrZero(r?.output_tokens),
      cacheReadTokens: numOrZero(r?.cache_read_tokens),
      cacheWriteTokens: numOrZero(r?.cache_write_tokens),
    };
    if (r && r.cost_rows > 0n) total.costUsd = numOrZero(r.cost_usd);
    if (r && r.api_ms_rows > 0n) total.durationApiMs = numOrZero(r.api_ms);
    return { usage: total };
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
