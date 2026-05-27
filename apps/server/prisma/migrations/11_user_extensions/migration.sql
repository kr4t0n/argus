-- Opt-in extensions the user has enabled, as a JSON map of
-- extension-id → boolean (e.g. {"notes": true}). An account-level
-- preference (synced across browsers) rather than device-local UI
-- state. JSON so adding an extension needs no migration. NULL =
-- nothing enabled.
ALTER TABLE "User" ADD COLUMN "extensions" JSONB;
