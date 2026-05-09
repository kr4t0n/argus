-- One latest-quota snapshot per (machine, agent type). Sidecars probe
-- each installed CLI's OAuth file (claude-code's ~/.claude/.credentials.json,
-- codex's ~/.codex/auth.json) on a slow timer and ship the result piggy-
-- backed on machine-heartbeat events; the server upserts here.
CREATE TABLE "MachineAgentQuota" (
    "id"        TEXT         NOT NULL,
    "machineId" TEXT         NOT NULL,
    "agentType" TEXT         NOT NULL,
    "source"    TEXT         NOT NULL,
    "windows"   JSONB        NOT NULL,
    "error"     TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineAgentQuota_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MachineAgentQuota_machineId_agentType_key"
    ON "MachineAgentQuota"("machineId", "agentType");

CREATE INDEX "MachineAgentQuota_agentType_idx"
    ON "MachineAgentQuota"("agentType");

ALTER TABLE "MachineAgentQuota"
    ADD CONSTRAINT "MachineAgentQuota_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
