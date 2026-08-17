import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SessionSearchHitDTO, SessionSearchResponse } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Highlight sentinels wrapped around matched terms in a snippet.
 *  Deliberately NOT `<b>`/`</b>` (ts_headline's default): the client
 *  splits on these to build React nodes, so nothing user-authored ever
 *  reaches an HTML sink. Mirrored in apps/web/src/components/SearchPalette.tsx. */
const HL_START = '[[hl]]';
const HL_STOP = '[[/hl]]';

/** ts_headline tuning. Two fragments is enough to show why a turn matched
 *  without the row growing into a paragraph. */
const HEADLINE_OPTS =
  `StartSel="${HL_START}", StopSel="${HL_STOP}", ` +
  'MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
/** Chars of context to show either side of a substring-fallback match. */
const FALLBACK_PAD = 90;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rebuild the search doc for one command. Called from the result
   * ingestor when a turn finalizes — the only point at which the turn's
   * full text exists.
   *
   * One statement, no round-trips: the doc is assembled server-side by
   * `argus_command_doc()` (the same function the backfill migration
   * used). Re-running is idempotent, so a duplicate final is harmless.
   */
  async indexCommand(commandId: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "CommandSearchDoc" ("commandId", "sessionId", "userId", "doc", "updatedAt")
      SELECT c.id, c."sessionId", s."userId", argus_command_doc(c.id), CURRENT_TIMESTAMP
        FROM "Command" c
        JOIN "Session" s ON s.id = c."sessionId"
       WHERE c.id = ${commandId}
         AND argus_command_doc(c.id) <> ''
      ON CONFLICT ("commandId") DO UPDATE
        SET "doc"       = EXCLUDED."doc",
            "sessionId" = EXCLUDED."sessionId",
            "userId"    = EXCLUDED."userId",
            "updatedAt" = CURRENT_TIMESTAMP
    `;
  }

  /**
   * Full-text search across every one of the caller's sessions —
   * archived included. Results are one-per-session (the best-ranked turn
   * in each) so a single chatty session can't crowd out the rest.
   *
   * Two-pass by design. The primary pass is a GIN-indexed `tsvector`
   * match with the last term treated as a prefix, which makes
   * search-as-you-type work. When that finds nothing we fall back to a
   * raw substring scan, because `tsvector` matches stemmed WORDS and
   * this is a developer tool: `MAXLEN`, `rediss://` and half-typed
   * identifiers are exactly what people search for and exactly what
   * word-matching misses. The fallback is a sequential scan and would be
   * indefensible on a large corpus; at this one's size (~7k rows) it is
   * ~100 ms, and buying correctness with cheap scans is the whole
   * advantage of small data.
   */
  async searchSessions(
    userId: string,
    rawQuery: string,
    limit = DEFAULT_LIMIT,
  ): Promise<SessionSearchResponse> {
    const query = rawQuery.trim();
    const capped = Math.min(Math.max(limit, 1), MAX_LIMIT);
    if (query.length < 2) return { query, hits: [], mode: 'fulltext' };

    const tsQuery = buildPrefixTsQuery(query);
    if (tsQuery) {
      const hits = await this.fullTextPass(userId, tsQuery, capped);
      if (hits.length > 0) return { query, hits, mode: 'fulltext' };
    }
    return { query, hits: await this.substringPass(userId, query, capped), mode: 'substring' };
  }

  private async fullTextPass(
    userId: string,
    tsQuery: string,
    limit: number,
  ): Promise<SessionSearchHitDTO[]> {
    // `matchCount` counts every matching turn in the session while
    // `DISTINCT ON` keeps only the best one, so the row can say
    // "12 matching turns" while showing the single most relevant snippet.
    // ts_headline is the expensive part, so it runs on the final page
    // only — after DISTINCT ON and after LIMIT.
    const rows = await this.prisma.$queryRaw<
      { sessionId: string; commandId: string; matchCount: number; snippet: string }[]
    >`
      WITH q AS (SELECT to_tsquery('english', ${tsQuery}) AS query),
      hits AS (
        SELECT d."sessionId", d."commandId", d.doc,
               ts_rank(d.tsv, q.query) AS rank,
               count(*) OVER (PARTITION BY d."sessionId") AS session_hits
          FROM "CommandSearchDoc" d, q
         WHERE d."userId" = ${userId}
           AND d.tsv @@ q.query
      ),
      best AS (
        SELECT DISTINCT ON ("sessionId") *
          FROM hits
         ORDER BY "sessionId", rank DESC
      ),
      top AS (
        SELECT * FROM best ORDER BY rank DESC LIMIT ${limit}
      )
      SELECT t."sessionId"                                              AS "sessionId",
             t."commandId"                                              AS "commandId",
             t.session_hits::int                                        AS "matchCount",
             ts_headline('english', t.doc, q.query, ${HEADLINE_OPTS})   AS snippet
        FROM top t, q
       ORDER BY t.rank DESC
    `;
    return rows;
  }

  /** Substring fallback — see searchSessions() for why this exists. */
  private async substringPass(
    userId: string,
    query: string,
    limit: number,
  ): Promise<SessionSearchHitDTO[]> {
    const pattern = `%${escapeLike(query)}%`;
    const rows = await this.prisma.$queryRaw<
      { sessionId: string; commandId: string; matchCount: number; doc: string }[]
    >`
      WITH hits AS (
        SELECT d."sessionId", d."commandId", d.doc,
               count(*) OVER (PARTITION BY d."sessionId") AS session_hits
          FROM "CommandSearchDoc" d
         WHERE d."userId" = ${userId}
           AND d.doc ILIKE ${pattern} ESCAPE '\\'
      ),
      best AS (
        SELECT DISTINCT ON ("sessionId") *
          FROM hits
         ORDER BY "sessionId", length(doc) ASC
      )
      SELECT b."sessionId"        AS "sessionId",
             b."commandId"        AS "commandId",
             b.session_hits::int  AS "matchCount",
             b.doc                AS doc
        FROM best b
       LIMIT ${limit}
    `;
    // Snippet extraction happens here rather than in SQL so the fallback
    // emits the same [[hl]] markup ts_headline does and the client needs
    // only one render path.
    return rows.map(({ doc, ...rest }) => ({
      ...rest,
      snippet: substringSnippet(doc, query),
    }));
  }

  /** Fire-and-forget wrapper: indexing must never break chunk ingestion. */
  indexCommandSafe(commandId: string): void {
    this.indexCommand(commandId).catch((err) => {
      this.logger.warn(
        `search index failed for command ${commandId}: ${
          err instanceof Prisma.PrismaClientKnownRequestError ? err.code : String(err)
        }`,
      );
    });
  }
}

/**
 * Turn free text into a `to_tsquery` expression, with the final term
 * prefix-matched so a half-typed word still hits while the user types.
 *
 * Tokenizing to `[a-z0-9_]+` and rebuilding the expression ourselves —
 * rather than passing user text to `to_tsquery` — is what keeps operator
 * characters (`&`, `|`, `!`, `:`, parens) from reaching the parser and
 * throwing a syntax error on input as ordinary as "foo (bar)". Returns
 * null when nothing survives tokenization (e.g. "!!!"), which routes the
 * search to the substring pass instead.
 */
function buildPrefixTsQuery(raw: string): string | null {
  const terms = raw.toLowerCase().match(/[a-z0-9_]+/g);
  if (!terms || terms.length === 0) return null;
  return terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(' & ');
}

/** Escape LIKE wildcards so a literal % or _ in the query stays literal. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Window `doc` around the first match, marked up like ts_headline's output. */
function substringSnippet(doc: string, query: string): string {
  const at = doc.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return doc.slice(0, FALLBACK_PAD * 2);
  const from = Math.max(0, at - FALLBACK_PAD);
  const to = Math.min(doc.length, at + query.length + FALLBACK_PAD);
  return (
    (from > 0 ? '… ' : '') +
    doc.slice(from, at) +
    HL_START +
    doc.slice(at, at + query.length) +
    HL_STOP +
    doc.slice(at + query.length, to) +
    (to < doc.length ? ' …' : '')
  );
}
