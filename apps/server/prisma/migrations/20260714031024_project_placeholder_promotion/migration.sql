-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "archiveSnapshot" JSONB,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "name" TEXT,
ADD COLUMN     "supportsTerminal" BOOLEAN NOT NULL DEFAULT false;
