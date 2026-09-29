import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SessionSearchHitDTO, SessionSearchResponse } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Highlight sentinels wrapped around matched terms in a snippet.
 *  Deliberately NOT `<b>`/`</b>` (ts_headline's default): the client
 *  splits on these to build React nodes, so nothing user-authored ever
 *  reaches an HTML sink. Mirrored as SEARCH_HL_START/SEARCH_HL_STOP in
 *  @argus/shared-types. */
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

/**
 * How far a session's own activity pulls its hits forward in time. Every
 * hit is dated by an EFFECTIVE time between when its turn was said and
 * when its session was last worked in (the session's newest turn, matching
 * or not):
 *
 *   effective_at = turn_at + SESSION_RECENCY_WEIGHT · (last_turn_at − turn_at)
 *
 * A session's newest turn is never older than any of its turns, so session
 * activity can only move a hit forward, never back: an old turn in a
 * session still in use reads as fresher than the same turn in one
 * abandoned long ago, and a dormant session ranks as its turns alone would.
 * 0 ignores the session entirely; 1 dates every hit by its session alone.
 *
 * Session activity is the newest Command row, deliberately NOT
 * `Session.updatedAt`: that column moves on every write to the row —
 * archive, unarchive, rename, model change, markSeen — so archiving a
 * project (which archives each of its sessions) would float that project's
 * entire history to the top of the results.
 */
const SESSION_RECENCY_WEIGHT = 0.5;

/**
 * Full-text pass only: `score = ts_rank / (1 + age_days / RECENCY_HALVING_DAYS)`,
 * age measured to `effective_at`. A hit this old keeps half its rank,
 * three times this old a quarter, a year old about a thirteenth.
 *
 * Multiplied, not added, because ts_rank has no fixed scale: for a single
 * term it is a term-frequency score confined to a narrow band, for an AND
 * of terms it is dominated by how close together they sit and spans orders
 * of magnitude. A ratio means the same thing at every magnitude — a hit
 * this much older needs twice the rank to tie. Hyperbolic rather than
 * exponential because ⌘K exists to excavate history: a curve steep enough
 * to matter this month would bury every strong match from last year.
 *
 * Neither this nor SESSION_RECENCY_WEIGHT has been tuned against the live
 * corpus.
 */
const RECENCY_HALVING_DAYS = 30;

/**
 * The recency CTEs both passes share, so they cannot drift into dating hits
 * differently. Expects a preceding CTE named `hits` with one row per
 * matching turn carrying `"sessionId"` and `turn_at`; yields `dated`, which
 * is `hits` plus `effective_at`.
 *
 * `last_turn` reads the newest turn of each matched session over the
 * (sessionId, createdAt) index — including a turn still running, which is
 * exactly when a session is most in use.
 */
const RECENCY_CTES = Prisma.sql`
  last_turn AS (
    SELECT c."sessionId", max(c."createdAt") AS last_at
      FROM "Command" c
     WHERE c."sessionId" IN (SELECT "sessionId" FROM hits)
     GROUP BY c."sessionId"
  ),
  dated AS (
    SELECT h.*,
           h.turn_at + (l.last_at - h.turn_at) * ${SESSION_RECENCY_WEIGHT}::float8 AS effective_at
      FROM hits h
      JOIN last_turn l ON l."sessionId" = h."sessionId"
  )
`;

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
   * archived included. Results are one-per-session (the best-scoring turn
   * in each) so a single chatty session can't crowd out the rest. Both
   * passes weigh recency — of the turn and of its session, see
   * SESSION_RECENCY_WEIGHT — and archived sessions get no extra demotion:
   * ⌘K is for excavating history, and age already does that work.
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
    // The per-session pick and the final order use the SAME score, so the
    // snippet shown (and the turn `?turn=` deep-links to) is the one that
    // earned the session its place. `doc` is joined back in only for the
    // final page: ts_headline is the expensive part, so it runs after
    // DISTINCT ON and after LIMIT, and `hits` stays slim.
    // Age is taken against `now() AT TIME ZONE 'UTC'` because timestamps
    // are `timestamp without time zone` holding UTC; a bare
    // `now() - effective_at` would read them in the connection's zone.
    const rows = await this.prisma.$queryRaw<
      { sessionId: string; commandId: string; matchCount: number; snippet: string }[]
    >`
      WITH q AS (SELECT to_tsquery('english', ${tsQuery}) AS query),
      hits AS (
        SELECT d."sessionId", d."commandId", c."createdAt" AS turn_at,
               ts_rank(d.tsv, q.query) AS rank,
               count(*) OVER (PARTITION BY d."sessionId") AS session_hits
          FROM "CommandSearchDoc" d
          JOIN "Command" c ON c.id = d."commandId"
         CROSS JOIN q
         WHERE d."userId" = ${userId}
           AND d.tsv @@ q.query
      ),
      ${RECENCY_CTES},
      scored AS (
        SELECT dt.*,
               dt.rank / (1 + greatest(0, extract(epoch FROM (now() AT TIME ZONE 'UTC') - dt.effective_at))
                              / 86400 / ${RECENCY_HALVING_DAYS}::float8) AS score
          FROM dated dt
      ),
      best AS (
        SELECT DISTINCT ON ("sessionId") *
          FROM scored
         ORDER BY "sessionId", score DESC, turn_at DESC, "commandId" DESC
      ),
      top AS (
        SELECT * FROM best
         ORDER BY score DESC, effective_at DESC, "sessionId"
         LIMIT ${limit}
      )
      SELECT t."sessionId"                                              AS "sessionId",
             t."commandId"                                              AS "commandId",
             t.session_hits::int                                        AS "matchCount",
             ts_headline('english', d.doc, q.query, ${HEADLINE_OPTS})   AS snippet
        FROM top t
        JOIN "CommandSearchDoc" d ON d."commandId" = t."commandId"
       CROSS JOIN q
       ORDER BY t.score DESC, t.effective_at DESC, t."sessionId"
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
    // A substring match is yes/no — there is no rank to weigh — so the
    // effective time IS the ordering: the newest matching turn per
    // session, sessions newest first. The explicit ORDER BY on `top` is
    // load-bearing. Without one, rows leave in DISTINCT ON's sort order,
    // i.e. by session id — and cuids are time-prefixed, so LIMIT kept the
    // OLDEST matching sessions and dropped every recent one.
    const rows = await this.prisma.$queryRaw<
      { sessionId: string; commandId: string; matchCount: number; doc: string }[]
    >`
      WITH hits AS (
        SELECT d."sessionId", d."commandId", c."createdAt" AS turn_at,
               count(*) OVER (PARTITION BY d."sessionId") AS session_hits
          FROM "CommandSearchDoc" d
          JOIN "Command" c ON c.id = d."commandId"
         WHERE d."userId" = ${userId}
           AND d.doc ILIKE ${pattern} ESCAPE '\\'
      ),
      ${RECENCY_CTES},
      best AS (
        SELECT DISTINCT ON ("sessionId") *
          FROM dated
         ORDER BY "sessionId", effective_at DESC, "commandId" DESC
      ),
      top AS (
        SELECT * FROM best
         ORDER BY effective_at DESC, "sessionId"
         LIMIT ${limit}
      )
      SELECT t."sessionId"        AS "sessionId",
             t."commandId"        AS "commandId",
             t.session_hits::int  AS "matchCount",
             d.doc                AS doc
        FROM top t
        JOIN "CommandSearchDoc" d ON d."commandId" = t."commandId"
       ORDER BY t.effective_at DESC, t."sessionId"
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
