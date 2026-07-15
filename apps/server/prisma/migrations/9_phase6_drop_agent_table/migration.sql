-- Phase 6 sweep — drop the Agent table entirely
-- (docs/plan-agent-to-runners.md).
--
-- The Agent entity is fully retired: sessions route by projectId →
-- machine + cliType → runner stream, per-machine resources scale with
-- installed CLIs (bounded) not projects (unbounded). Phase 5 already
-- dropped the Session/Command/Terminal.agentId FK columns; this removes
-- the last readers (Machine.agentCount, the syncProjects backfill, the
-- machine-delete cascade, and the fs/git/terminal/models representative
-- lookups) so nothing references the table anymore.
--
-- No table has an FK to "Agent" at this point (the child FKs went in
-- Phase 5, and Machine→Agent was a Prisma-side relation with the column
-- on Agent), so a plain DROP is sufficient. Named `9_phase6_…` so it
-- sorts lexicographically AFTER 6/7/8_backfill_command_usage (which JOIN
-- Agent) and after 9_phase5 — a `2026…` timestamp would sort before them
-- and break a fresh `migrate deploy`.

-- DropTable
DROP TABLE "Agent";
