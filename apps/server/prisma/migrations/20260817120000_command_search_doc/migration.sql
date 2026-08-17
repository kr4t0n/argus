-- Full-text search over session content.
--
-- Adds `CommandSearchDoc`: one materialized row per Command holding that
-- turn's conversation text plus a generated `tsvector`, indexed with GIN.
--
-- The load-bearing detail is WHY this is a derived table rather than a
-- query over ResultChunk: assistant answers are persisted as a stream of
-- `delta` fragments, so a multi-word keyword can straddle two rows and
-- row-level matching misses it silently. Concatenating per command — in
-- `seq` order, with NO separator between deltas, since a space would
-- manufacture a word boundary mid-token — is what makes matching correct.
--
-- `stdout` / `tool` / `progress` / `stderr` chunks are deliberately NOT
-- indexed. On the corpus this was designed against they are ~78 MB / 22 MB
-- / 1 MB / 1 MB respectively against ~36 MB of actual conversation, and
-- they are build logs, MCP payloads and status noise — including them
-- would triple the index and bury real hits under npm output.

-- ─────────────────────────────────────────────────────────────────────
-- The doc definition, in exactly one place.
--
-- Both the backfill below and the runtime upsert in SearchService call
-- this, so the two can never drift into indexing different text.
--
-- `left(..., 900000)`: to_tsvector throws above 1 MB of input. The
-- observed p99 turn is ~21 KB and the max ~103 KB, so this is pure
-- insurance against one runaway turn poisoning ingestion.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION argus_command_doc(cmd_id text) RETURNS text AS $$
  SELECT left(
    btrim(
      coalesce((SELECT c.prompt FROM "Command" c WHERE c.id = cmd_id), '')
      || coalesce(
           (SELECT E'\n\n' || string_agg(rc.delta, '' ORDER BY rc.seq)
              FROM "ResultChunk" rc
             WHERE rc."commandId" = cmd_id
               AND rc.kind = 'delta'
               AND rc.delta IS NOT NULL),
           '')
      || coalesce(
           (SELECT E'\n\n' || string_agg(rc.content, E'\n\n' ORDER BY rc.seq)
              FROM "ResultChunk" rc
             WHERE rc."commandId" = cmd_id
               AND rc.kind = 'final'
               AND rc.content IS NOT NULL),
           '')
    ),
    900000)
$$ LANGUAGE sql STABLE;

-- CreateTable
CREATE TABLE "CommandSearchDoc" (
    "commandId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "doc" TEXT NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', "doc")) STORED,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandSearchDoc_pkey" PRIMARY KEY ("commandId")
);

-- CreateIndex
CREATE INDEX "CommandSearchDoc_userId_idx" ON "CommandSearchDoc"("userId");

-- CreateIndex
CREATE INDEX "CommandSearchDoc_sessionId_idx" ON "CommandSearchDoc"("sessionId");

-- CreateIndex
CREATE INDEX "CommandSearchDoc_tsv_idx" ON "CommandSearchDoc" USING GIN ("tsv");

-- AddForeignKey
ALTER TABLE "CommandSearchDoc" ADD CONSTRAINT "CommandSearchDoc_commandId_fkey"
    FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- Backfill history. Single-shot: the corpus this was written against is
-- ~7k commands / ~36 MB of text, which runs in seconds. Empty docs
-- (a turn with no prompt and no answer — cancelled before it produced
-- anything) are skipped; there is nothing to match on.
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO "CommandSearchDoc" ("commandId", "sessionId", "userId", "doc", "updatedAt")
SELECT c.id, c."sessionId", s."userId", argus_command_doc(c.id), CURRENT_TIMESTAMP
  FROM "Command" c
  JOIN "Session" s ON s.id = c."sessionId"
 WHERE argus_command_doc(c.id) <> '';

ANALYZE "CommandSearchDoc";
