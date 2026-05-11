-- Denormalize per-command token usage so /me/usage can SUM a column
-- instead of scanning every `final` ResultChunk's raw `meta` JSONB.
--
-- The column is populated going forward by the result-ingestor when a
-- turn finalizes; existing rows stay NULL until the backfill script
-- (`pnpm -F @argus/server backfill:usage`) walks them.
--
-- NULL is the "no usage recorded" sentinel — used both for in-flight
-- commands and for finished turns whose adapter emitted no usage
-- payload (cancellations, errors, custom adapters). The aggregation
-- query filters to `usage IS NOT NULL` so NULLs cost nothing.
ALTER TABLE "Command"
    ADD COLUMN "usage" JSONB NULL;
