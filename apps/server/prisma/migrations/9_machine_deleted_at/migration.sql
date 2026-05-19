-- Sticky soft-delete tombstone for a Machine. Deliberately separate
-- from `archivedAt`: the machine-register handler resets `archivedAt`
-- to NULL on every re-register (a live sidecar un-archives itself),
-- whereas `deletedAt` is never cleared by the lifecycle consumer —
-- once set, register/heartbeat events from that sidecar are ignored,
-- so a still-running or restarting sidecar can no longer resurrect a
-- deleted machine. NULL = not deleted.
--
-- This is a tombstone only: NO child rows are removed. Agents are
-- soft-hidden via their existing `archivedAt`; sessions, commands,
-- result chunks, and terminals are left fully intact so conversation
-- history survives and stays viewable through the normal session UI.
ALTER TABLE "Machine" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- listMachines / getMachine / createAgent and the lifecycle guards all
-- filter on `deletedAt IS NULL`; index it like the sibling `archivedAt`.
CREATE INDEX "Machine_deletedAt_idx" ON "Machine"("deletedAt");
