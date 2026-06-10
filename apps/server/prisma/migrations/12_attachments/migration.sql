-- Attachments: files the user attaches to a turn. The bytes live in
-- S3/MinIO under `s3Key`; this table holds the metadata, ownership, and
-- the link to the Command the file was sent with.
--
-- `commandId` is nullable on purpose: the dashboard uploads a file
-- (POST /attachments) BEFORE the turn exists, then the dispatch path
-- links it to the freshly-created Command. Both FKs cascade so deleting
-- a user or a command removes the rows (the S3 object is deleted
-- best-effort by the service on that path; an orphan sweep is a
-- follow-up). `commandId IS NULL` rows are unlinked uploads (composer
-- abandoned before send) and are safe to prune by age.

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "commandId" TEXT,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "s3Key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_commandId_idx" ON "Attachment"("commandId");

-- CreateIndex
CREATE INDEX "Attachment_userId_createdAt_idx" ON "Attachment"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE CASCADE ON UPDATE CASCADE;
