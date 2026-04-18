-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Agent_archivedAt_idx" ON "Agent"("archivedAt");
