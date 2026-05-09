// One-shot backfill that walks every completed Command lacking a
// `usage` value and populates it from its final/error chunk's `meta`.
//
// Run with `pnpm -F @argus/server backfill:usage` after applying
// migration `5_command_usage`. Idempotent — re-running only touches
// rows that are still NULL, so it's safe to retry on partial runs.
//
// Why a script instead of inlining the backfill into the migration:
// the adapter-specific normalizations (codex `input - cached`, cursor
// camelCase, claude-code's hoisted `total_cost_usd` / `duration_api_ms`)
// are non-trivial to re-implement in SQL. Reusing the shared
// `parseUsage` keeps backfilled rows byte-identical to rows the
// ingestor would write live.

import { PrismaClient } from '@prisma/client';
import type { AgentType } from '@argus/shared-types';
import { parseUsage } from '@argus/shared-types';

const BATCH_SIZE = 200;

const prisma = new PrismaClient();

async function main() {
  let processed = 0;
  let written = 0;

  while (true) {
    // Pull a page of commands that finalized but have no usage yet.
    // We page by cursor (id) instead of skip so we don't re-scan rows
    // we already updated when the page shifts.
    const page = await prisma.command.findMany({
      where: {
        usage: { equals: null as never },
        status: { in: ['completed', 'failed'] },
      },
      select: {
        id: true,
        agent: { select: { type: true } },
        chunks: {
          where: { OR: [{ kind: 'final' }, { kind: 'error' }] },
          orderBy: { seq: 'desc' },
          take: 1,
          select: { meta: true },
        },
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });

    if (page.length === 0) break;

    for (const cmd of page) {
      processed += 1;
      const final = cmd.chunks[0];
      if (!final) continue;
      const meta = (final.meta ?? null) as Record<string, unknown> | null;
      if (!meta) continue;
      const parsed = parseUsage(cmd.agent.type as AgentType, meta);
      if (!parsed) continue;
      await prisma.command.update({
        where: { id: cmd.id },
        // Cast through unknown — Prisma typed Json input as
        // InputJsonValue, which TokenUsage satisfies structurally.
        data: { usage: parsed as unknown as object },
      });
      written += 1;
    }

    // If the page came back smaller than the batch size we've reached
    // the tail. Otherwise loop again — the next page picks up the
    // remaining still-NULL rows because the matched set is shrinking.
    if (page.length < BATCH_SIZE) break;

    if (processed % 1_000 === 0) {
      console.log(`  processed=${processed} written=${written}`);
    }
  }

  console.log(`backfill complete: processed=${processed} written=${written}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
