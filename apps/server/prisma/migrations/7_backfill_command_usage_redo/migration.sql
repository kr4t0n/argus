-- Redo of migration 6_backfill_command_usage. The previous migration
-- ran to completion (recorded in `_prisma_migrations`) but its
-- `pg_temp` PL/pgSQL helper produced NULL for every probe in
-- production — the COALESCEs collapsed to 0, the `WHERE input>0 OR
-- output>0 …` predicate skipped every row, and 0 historical commands
-- got backfilled. Diagnostics on the live DB showed `meta->'usage'`
-- is well-shaped (the codex envelope `{input_tokens, output_tokens,
-- cached_input_tokens, …}`); the data is fine, the helper isn't.
--
-- This rewrite drops PL/pgSQL + `pg_temp` entirely:
--   - `_argus_jnum` is a `LANGUAGE sql` function in the public
--     schema, dropped at the end. SQL functions don't carry the
--     variadic / exception-block edge cases of PL/pgSQL.
--   - `jsonb_typeof = 'number'` gates the cast so a malformed payload
--     yields NULL instead of crashing the migration.
--
-- Idempotent: only touches rows where `Command.usage IS NULL`. If
-- migration 6 had worked, this matches 0 rows and exits cheaply.

CREATE FUNCTION _argus_jnum(j jsonb, k text) RETURNS numeric AS $$
  SELECT CASE jsonb_typeof(j->k)
           WHEN 'number' THEN (j->>k)::numeric
           ELSE NULL
         END
$$ LANGUAGE sql IMMUTABLE;

WITH latest_final AS (
  SELECT DISTINCT ON (r."commandId")
    r."commandId" AS command_id,
    r.meta        AS meta
  FROM "ResultChunk" r
  JOIN "Command"     c ON c.id = r."commandId"
  WHERE r.kind IN ('final', 'error')
    AND c.usage IS NULL
    AND c.status IN ('completed', 'failed')
  ORDER BY r."commandId", r.seq DESC
),
computed AS (
  SELECT
    lf.command_id,

    GREATEST(0, CASE a.type
      WHEN 'codex' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'input_tokens'), 0)
        - COALESCE(_argus_jnum(lf.meta->'usage', 'cached_input_tokens'), 0)
      WHEN 'cursor-cli' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'inputTokens'), 0)
      WHEN 'claude-code' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'input_tokens'), 0)
      ELSE
        COALESCE(
          _argus_jnum(lf.meta->'usage', 'input_tokens'),
          _argus_jnum(lf.meta->'usage', 'inputTokens'),
          0)
    END) AS input_tokens,

    CASE a.type
      WHEN 'cursor-cli' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'outputTokens'), 0)
      ELSE
        COALESCE(
          _argus_jnum(lf.meta->'usage', 'output_tokens'),
          _argus_jnum(lf.meta->'usage', 'outputTokens'),
          0)
    END AS output_tokens,

    CASE a.type
      WHEN 'codex' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'cached_input_tokens'), 0)
      WHEN 'cursor-cli' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'cacheReadTokens'), 0)
      WHEN 'claude-code' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'cache_read_input_tokens'), 0)
      ELSE
        COALESCE(
          _argus_jnum(lf.meta->'usage', 'cache_read_input_tokens'),
          _argus_jnum(lf.meta->'usage', 'cached_input_tokens'),
          _argus_jnum(lf.meta->'usage', 'cacheReadTokens'),
          0)
    END AS cache_read_tokens,

    CASE a.type
      WHEN 'codex' THEN 0::numeric
      WHEN 'cursor-cli' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'cacheWriteTokens'), 0)
      WHEN 'claude-code' THEN
        COALESCE(_argus_jnum(lf.meta->'usage', 'cache_creation_input_tokens'), 0)
      ELSE
        COALESCE(
          _argus_jnum(lf.meta->'usage', 'cache_creation_input_tokens'),
          _argus_jnum(lf.meta->'usage', 'cacheWriteTokens'),
          0)
    END AS cache_write_tokens,

    CASE a.type
      WHEN 'claude-code' THEN _argus_jnum(lf.meta, 'total_cost_usd')
      ELSE NULL::numeric
    END AS cost_usd,

    CASE a.type
      WHEN 'claude-code' THEN _argus_jnum(lf.meta, 'duration_api_ms')
      WHEN 'cursor-cli'  THEN _argus_jnum(lf.meta, 'duration_api_ms')
      ELSE NULL::numeric
    END AS duration_api_ms

  FROM latest_final lf
  JOIN "Command" c ON c.id = lf.command_id
  JOIN "Agent"   a ON a.id = c."agentId"
  WHERE jsonb_typeof(lf.meta->'usage') = 'object'
)
UPDATE "Command" c
SET usage =
  jsonb_build_object(
    'inputTokens',      cp.input_tokens,
    'outputTokens',     cp.output_tokens,
    'cacheReadTokens',  cp.cache_read_tokens,
    'cacheWriteTokens', cp.cache_write_tokens
  )
  || CASE WHEN cp.cost_usd IS NOT NULL
          THEN jsonb_build_object('costUsd', cp.cost_usd)
          ELSE '{}'::jsonb END
  || CASE WHEN cp.duration_api_ms IS NOT NULL
          THEN jsonb_build_object('durationApiMs', cp.duration_api_ms)
          ELSE '{}'::jsonb END
FROM computed cp
WHERE c.id = cp.command_id
  AND (cp.input_tokens > 0
       OR cp.output_tokens > 0
       OR cp.cache_read_tokens > 0
       OR cp.cache_write_tokens > 0
       OR (cp.cost_usd IS NOT NULL AND cp.cost_usd > 0));

DROP FUNCTION _argus_jnum(jsonb, text);
