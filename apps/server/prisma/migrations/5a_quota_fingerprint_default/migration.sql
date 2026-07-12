-- Corrective migration for drift left by 4_machine_agent_quota_fingerprint:
-- the fingerprint column kept its backfill DEFAULT while schema.prisma
-- declares none. The drop originally rode inside
-- 20260706054229_add_device_tokens, but that name sorts lexicographically
-- BEFORE 3_/4_ (Prisma replays migrations in directory-name order), which
-- broke fresh-database replays. This copy sorts after 4_ and dropping an
-- absent default is a no-op, so it is safe on databases that already ran
-- the original.
ALTER TABLE "MachineAgentQuota" ALTER COLUMN "fingerprint" DROP DEFAULT;
