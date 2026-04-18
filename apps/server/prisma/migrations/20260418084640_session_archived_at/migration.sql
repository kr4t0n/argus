-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Session_userId_archivedAt_idx" ON "Session"("userId", "archivedAt");
