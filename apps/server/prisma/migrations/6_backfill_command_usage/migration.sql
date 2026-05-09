-- Backfill Command.usage for every command that completed BEFORE
-- migration 5_command_usage added the column. Mirrors the parser in
-- packages/shared-types/src/usage.ts so backfilled rows are
-- byte-identical to ones the live ingestor writes going forward.
--
-- Once-only by virtue of Prisma's `_prisma_migrations` table — this
-- migration runs exactly once per database, so subsequent deploys
-- skip the work entirely. Commands that finalize *after* this
-- migration are populated live by result-ingestor.service.ts.
--
-- Drift caveat: if `parseUsage`'s output shape ever changes (new
-- field, renamed field), this SQL diverges from the TS parser for
-- pre-existing rows until a follow-up migration re-backfills them.
-- Same risk we'd have with any backfill strategy — the live ingestor
-- can switch to a new shape without rewriting history.

-- Helper: extract the first defined numeric field by key, mirroring
-- shared-types pickNumber+asNumber. Tries each key in order; accepts
-- both JSON numbers and numeric-string values; returns NULL when
-- nothing matches. `pg_temp` makes it session-local so it cleans up
-- on its own when the migration's connection closes.
CREATE FUNCTION pg_temp._argus_pick_num(j jsonb, VARIADIC keys text[])
RETURNS numeric AS $$
DECLARE
  k text;
  s text;
BEGIN
  IF j IS NULL THEN
    RETURN NULL;
  END IF;
  FOREACH k IN ARRAY keys LOOP
    s := j->>k;
    IF s IS NULL THEN
      CONTINUE;
    END IF;
    -- ->>'.' returns the JSON value as text. Numbers serialize as
    -- their digit form; strings are unquoted. Anything that isn't
    -- numeric-looking (object, array, non-numeric string) raises on
    -- ::numeric cast; we swallow and keep probing the remaining keys.
    BEGIN
      RETURN s::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      CONTINUE;
    END;
  END LOOP;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

-- Pick the latest final/error chunk per command (highest seq wins),
-- restricted to commands that need backfilling.
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
-- Per agent type, normalize the four token buckets + optional cost
-- and api-duration. The CASE branches mirror `parseUsage`'s switch
-- statement one-for-one. Custom adapters fall through to a probe
-- across both naming conventions, same as the TS `default` case.
computed AS (
  SELECT
    lf.command_id,

    CASE a.type
      WHEN 'codex' THEN GREATEST(0,
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'input_tokens'), 0)
        - COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'cached_input_tokens'), 0))
      WHEN 'cursor-cli' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'inputTokens'), 0)
      WHEN 'claude-code' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'input_tokens'), 0)
      ELSE
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'input_tokens', 'inputTokens'), 0)
    END AS input_tokens,

    CASE a.type
      WHEN 'cursor-cli' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'outputTokens'), 0)
      ELSE
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'output_tokens', 'outputTokens'), 0)
    END AS output_tokens,

    CASE a.type
      WHEN 'codex' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'cached_input_tokens'), 0)
      WHEN 'cursor-cli' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'cacheReadTokens'), 0)
      WHEN 'claude-code' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'cache_read_input_tokens'), 0)
      ELSE
        COALESCE(pg_temp._argus_pick_num(
          lf.meta->'usage',
          'cache_read_input_tokens', 'cached_input_tokens', 'cacheReadTokens'
        ), 0)
    END AS cache_read_tokens,

    CASE a.type
      WHEN 'codex' THEN 0
      WHEN 'cursor-cli' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'cacheWriteTokens'), 0)
      WHEN 'claude-code' THEN
        COALESCE(pg_temp._argus_pick_num(lf.meta->'usage', 'cache_creation_input_tokens'), 0)
      ELSE
        COALESCE(pg_temp._argus_pick_num(
          lf.meta->'usage',
          'cache_creation_input_tokens', 'cacheWriteTokens'
        ), 0)
    END AS cache_write_tokens,

    -- Only claude-code emits cost. NULL signals "field absent" so we
    -- can omit it from the output JSONB rather than write a literal 0.
    CASE a.type
      WHEN 'claude-code' THEN pg_temp._argus_pick_num(lf.meta, 'total_cost_usd')
      ELSE NULL
    END AS cost_usd,

    -- claude-code and cursor-cli both surface api duration at the
    -- meta root (NOT inside `usage`). codex and unknown adapters
    -- don't, so leave NULL.
    CASE a.type
      WHEN 'claude-code' THEN pg_temp._argus_pick_num(lf.meta, 'duration_api_ms')
      WHEN 'cursor-cli'  THEN pg_temp._argus_pick_num(lf.meta, 'duration_api_ms')
      ELSE NULL
    END AS duration_api_ms

  FROM latest_final lf
  JOIN "Command" c ON c.id = lf.command_id
  JOIN "Agent"   a ON a.id = c."agentId"
  -- `usage` must be a JSON object — guards against missing key, JSON
  -- null, or malformed payload (e.g. error chunks with no usage).
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
  -- Mirror parseUsage's hasUsage() filter — don't write a row that
  -- the TS parser would have returned `null` for. If every token
  -- count is 0 and there's no positive cost, leave usage NULL so the
  -- Postgres aggregate query in /me/usage skips it like any other
  -- no-payload row.
  AND (cp.input_tokens > 0
       OR cp.output_tokens > 0
       OR cp.cache_read_tokens > 0
       OR cp.cache_write_tokens > 0
       OR (cp.cost_usd IS NOT NULL AND cp.cost_usd > 0));
