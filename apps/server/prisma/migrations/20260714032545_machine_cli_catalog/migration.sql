-- CreateTable
CREATE TABLE "MachineCliCatalog" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "cliType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "models" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineCliCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MachineCliCatalog_machineId_cliType_key" ON "MachineCliCatalog"("machineId", "cliType");

-- AddForeignKey
ALTER TABLE "MachineCliCatalog" ADD CONSTRAINT "MachineCliCatalog_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Backfill ─────────────────────────────────────────────────────────
-- Seed from the per-agent catalogs (Phase 2 of the agent→runner
-- refactor moves storage to machine×CLI): for each (machineId, type),
-- take the most recently probed agent's catalog. Agent.modelCatalog
-- stays in place (unread from here on) until Phase 4 drops it.
INSERT INTO "MachineCliCatalog" ("id", "machineId", "cliType", "source", "models", "fetchedAt", "updatedAt")
SELECT gen_random_uuid()::text,
       a."machineId",
       a."type",
       COALESCE(a."modelCatalog"->>'source', 'cli'),
       COALESCE(a."modelCatalog"->'models', '[]'::jsonb),
       a."modelCatalogAt",
       NOW()
FROM (
  SELECT DISTINCT ON ("machineId", "type") "machineId", "type", "modelCatalog", "modelCatalogAt"
  FROM "Agent"
  WHERE "modelCatalog" IS NOT NULL AND "modelCatalogAt" IS NOT NULL
  ORDER BY "machineId", "type", "modelCatalogAt" DESC
) a
ON CONFLICT ("machineId", "cliType") DO NOTHING;
