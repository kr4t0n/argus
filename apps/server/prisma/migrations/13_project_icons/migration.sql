-- Server-side metadata for a "project" — the (machineId, workingDir)
-- pair every session in that directory shares. Projects have no
-- first-class lifecycle row; this table exists for metadata that must
-- roam across browsers. Today that's just the user-picked icon glyph
-- (a single A-Z letter), workspace-shared like Machine.iconKey.
-- Resetting an icon keeps the row with iconKey NULL.

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "workingDir" TEXT NOT NULL,
    "iconKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_machineId_idx" ON "Project"("machineId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_machineId_workingDir_key" ON "Project"("machineId", "workingDir");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
