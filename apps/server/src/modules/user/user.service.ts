import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AgentType,
  TokenUsage,
  UserActivityResponse,
  UserRulesResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import {
  USER_RULES_MAX_BYTES,
  ZERO_USAGE,
  parseUsage,
  sumUsage,
} from '@argus/shared-types';
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
   * Token meta lives on each turn's `final` chunk; the field names
   * differ between adapters (claude vs codex vs cursor vs custom),
   * so we fan each chunk through the shared-types `parseUsage` with
   * the agent's type — same parser the dashboard's per-session
   * UsageBadge uses, keeping the totals consistent with what the user
   * sees per-session.
   *
   * Performance: a heavy user with ~5k final chunks parses in single-
   * digit milliseconds in Node; the join + scan is the dominant cost.
   * If this ever becomes hot we can denormalize a per-command
   * `usage` JSONB column populated by the result-ingestor, but the
   * straightforward scan is cheap enough for v1.
   */
  async usage(userId: string): Promise<UserUsageResponse> {
    const rows = await this.prisma.resultChunk.findMany({
      where: {
        kind: 'final',
        command: { session: { userId } },
      },
      select: {
        meta: true,
        command: { select: { agent: { select: { type: true } } } },
      },
    });

    let total: TokenUsage = ZERO_USAGE;
    for (const row of rows) {
      const meta = (row.meta ?? null) as Record<string, unknown> | null;
      const type = row.command.agent.type as AgentType;
      const u = parseUsage(type, meta);
      if (u) total = sumUsage(total, u);
    }
    return { usage: total };
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
