-- Terminals become (machine, cwd)-addressed — the last agent-addressed
-- surface (docs/plan-agent-to-runners.md, Phase-4 prerequisite). The
-- sidecar's PTY runner is machine-wide and takes an explicit cwd, so
-- nothing about a terminal needs an agent row.
--
-- Prisma's codegen wanted `ADD COLUMN "machineId" TEXT NOT NULL`, which
-- fails outright on a non-empty table. Hand-written here as the safe
-- three-step: add nullable → backfill from the agent join → tighten.

-- agentId becomes attribution-only: SetNull (not Cascade) so retiring
-- agent rows in Phase 4 can never delete terminal history.
ALTER TABLE "Terminal" DROP CONSTRAINT "Terminal_agentId_fkey";
ALTER TABLE "Terminal" ALTER COLUMN "agentId" DROP NOT NULL;

ALTER TABLE "Terminal" ADD COLUMN "machineId" TEXT;
ALTER TABLE "Terminal" ADD COLUMN "projectId" TEXT;

-- Backfill the routing key from the agent each terminal hangs off
-- (agentId is still populated in the data at this point).
UPDATE "Terminal" t
SET "machineId" = a."machineId"
FROM "Agent" a
WHERE t."agentId" = a."id";

-- ...and the project anchor, where the agent's workingDir has a Project
-- row (created by the Phase-1 backfill).
UPDATE "Terminal" t
SET "projectId" = p."id"
FROM "Agent" a
JOIN "Project" p
  ON p."machineId" = a."machineId" AND p."workingDir" = a."workingDir"
WHERE t."agentId" = a."id";

-- Any row whose agent vanished (shouldn't exist — the old FK cascaded)
-- has no machine to route to, so it can't be revived.
DELETE FROM "Terminal" WHERE "machineId" IS NULL;

ALTER TABLE "Terminal" ALTER COLUMN "machineId" SET NOT NULL;

-- Terminal capability was a per-agent opt-in; project-addressed opens
-- read it off the Project row, so inherit it wherever ANY agent under
-- the project had it. Without this, existing projects would lose their
-- terminal tab the moment a client switches to the project route.
UPDATE "Project" p
SET "supportsTerminal" = true
WHERE EXISTS (
  SELECT 1 FROM "Agent" a
  WHERE a."machineId" = p."machineId"
    AND a."workingDir" = p."workingDir"
    AND a."supportsTerminal" = true
);

-- CreateIndex
CREATE INDEX "Terminal_machineId_openedAt_idx" ON "Terminal"("machineId", "openedAt");

-- CreateIndex
CREATE INDEX "Terminal_projectId_openedAt_idx" ON "Terminal"("projectId", "openedAt");

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
