-- Phase 5 sweep — drop the vestigial Session/Command/Terminal.agentId
-- attribution columns (docs/plan-agent-to-runners.md).
--
-- Phase 4 left these as nullable attribution columns. They are now
-- fully unused: sessions route by projectId → machine + cliType →
-- runner stream, no client reads agentId, and the prod check
-- `SELECT count(*) FROM "Session" WHERE "projectId" IS NULL` returned 0
-- so no session still depends on the resolveRouting agent fallback.
--
-- The Agent TABLE is intentionally KEPT: it still feeds Machine.agentCount
-- and the syncProjects backfill (both keyed by machineId) and supplies a
-- representative agent for fs/git/terminal attribution echoes — none of
-- which use these FK columns. Only the three back-referencing columns go.

-- DropForeignKey
ALTER TABLE "Command" DROP CONSTRAINT "Command_agentId_fkey";
ALTER TABLE "Session" DROP CONSTRAINT "Session_agentId_fkey";
ALTER TABLE "Terminal" DROP CONSTRAINT "Terminal_agentId_fkey";

-- DropIndex
DROP INDEX "Command_agentId_createdAt_idx";
DROP INDEX "Session_agentId_updatedAt_idx";
DROP INDEX "Terminal_agentId_openedAt_idx";

-- AlterTable
ALTER TABLE "Command" DROP COLUMN "agentId";
ALTER TABLE "Session" DROP COLUMN "agentId";
ALTER TABLE "Terminal" DROP COLUMN "agentId";
