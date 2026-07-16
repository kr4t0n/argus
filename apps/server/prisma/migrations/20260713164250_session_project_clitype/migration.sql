-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "cliType" TEXT,
ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "Session_projectId_updatedAt_idx" ON "Session"("projectId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Backfill ─────────────────────────────────────────────────────────
-- Phase 1 of the agent→runner refactor (docs/plan-agent-to-runners.md):
-- sessions absorb their (project, CLI) identity from the agent they
-- were created under, so later phases can route without the Agent row.

-- 1. Promote every (machineId, workingDir) pair that has agents into a
--    Project row. ON CONFLICT keeps rows already created by the icon
--    path (which may carry a user-picked iconKey). gen_random_uuid()
--    yields uuid-shaped ids next to Prisma's cuid-shaped ones — both
--    are opaque TEXT to every consumer. "updatedAt" has no DB default
--    (Prisma @updatedAt is client-managed), so supply it explicitly.
INSERT INTO "Project" ("id", "machineId", "workingDir", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."machineId", a."workingDir", NOW(), NOW()
FROM (
  SELECT DISTINCT "machineId", "workingDir"
  FROM "Agent"
  WHERE "workingDir" IS NOT NULL AND "workingDir" <> ''
) a
ON CONFLICT ("machineId", "workingDir") DO NOTHING;

-- 2. Every session learns its CLI type from its agent, whether or not
--    the agent has a workingDir.
UPDATE "Session" s
SET "cliType" = a."type"
FROM "Agent" a
WHERE s."agentId" = a."id";

-- 3. Sessions whose agent has a workingDir anchor to that Project row.
--    Workdir-less agents' sessions stay NULL — the sidebar's synthetic
--    per-machine "no project" bucket.
UPDATE "Session" s
SET "projectId" = p."id"
FROM "Agent" a
JOIN "Project" p
  ON p."machineId" = a."machineId" AND p."workingDir" = a."workingDir"
WHERE s."agentId" = a."id";
