import { Injectable } from '@nestjs/common';
import type { UserActivityResponse } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';

const DAY_MS = 86_400_000;

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

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
