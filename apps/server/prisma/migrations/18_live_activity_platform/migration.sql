-- Android Live Updates register the device's FCM token PER SESSION, so a
-- token is no longer unique on its own: one phone can track several
-- running turns. iOS tokens are per-activity and remain unique in
-- practice. `platform` selects the transport the push service uses for
-- each row (default keeps every pre-existing row on APNs).
--
-- Named 18_… to sort right after 17_live_activity_tokens, which created
-- the table (see the migration-ordering gotcha in AGENTS.md).

-- AlterTable
ALTER TABLE "LiveActivityToken" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'ios';

-- DropIndex
DROP INDEX IF EXISTS "LiveActivityToken_token_key";

-- CreateIndex
CREATE UNIQUE INDEX "LiveActivityToken_token_sessionId_key" ON "LiveActivityToken"("token", "sessionId");

-- CreateIndex
CREATE INDEX "LiveActivityToken_token_idx" ON "LiveActivityToken"("token");
