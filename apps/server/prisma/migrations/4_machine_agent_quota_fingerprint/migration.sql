-- Quota is account-level, not machine-level. Add a per-account
-- fingerprint column so multiple machines reporting the same Anthropic
-- /ChatGPT/Cursor account dedupe to one group, and so a "logout"
-- tombstone (fingerprint='') can clear that machine's prior real row
-- without competing against other machines' real rows on `checkedAt`.

-- Existing rows predate the column. Default '' means they'll all be
-- treated as tombstones until the next sidecar heartbeat refreshes
-- them with a real fingerprint, which in practice is within ~5 s of
-- a sidecar reconnect (heartbeat interval).
ALTER TABLE "MachineAgentQuota"
    ADD COLUMN "fingerprint" TEXT NOT NULL DEFAULT '';

-- Swap the unique constraint over to include fingerprint so the
-- same machine can briefly carry both an old account row and a new
-- one mid-account-switch (the ingestor cleans up the loser on next
-- write).
DROP INDEX "MachineAgentQuota_machineId_agentType_key";
CREATE UNIQUE INDEX "MachineAgentQuota_machineId_agentType_fingerprint_key"
    ON "MachineAgentQuota"("machineId", "agentType", "fingerprint");

-- The lookup pattern in /me/quota is "find every row of agentType T,
-- group by fingerprint." Index on (agentType, fingerprint) makes that
-- a clean index scan; replaces the old single-column agentType index.
DROP INDEX "MachineAgentQuota_agentType_idx";
CREATE INDEX "MachineAgentQuota_agentType_fingerprint_idx"
    ON "MachineAgentQuota"("agentType", "fingerprint");
