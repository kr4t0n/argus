-- Phase 4 — retire Agent (docs/plan-agent-to-runners.md).
--
-- Session.agentId and Command.agentId become nullable attribution
-- columns: new rows created after Phase 4 carry NULL (they route via
-- projectId → machine + cliType → runner stream), while EXISTING values
-- are kept so old sessions still render their agent-derived history.
-- The FKs flip to SetNull so an agent row can be swept without deleting
-- conversation history. Agent.modelCatalog / modelCatalogAt are dropped
-- (catalogs moved to MachineCliCatalog in Phase 2; these went unread
-- since then). No data is nulled here — that happens naturally as new
-- sessions are created.
-- DropForeignKey
ALTER TABLE "Command" DROP CONSTRAINT "Command_agentId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_agentId_fkey";

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "modelCatalog",
DROP COLUMN "modelCatalogAt";

-- AlterTable
ALTER TABLE "Command" ALTER COLUMN "agentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Session" ALTER COLUMN "agentId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
