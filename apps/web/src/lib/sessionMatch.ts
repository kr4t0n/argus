import type { SessionDTO } from '@argus/shared-types';

/** One session plus the derived labels the switcher matches against.
 *  Assembled by the caller, which already holds the project/machine
 *  stores — this module stays pure so it can be reasoned about (and
 *  scored) without any store wiring. */
export interface SessionCandidate {
  session: SessionDTO;
  projectLabel: string | null;
  machineName: string | null;
}

export interface RankedSession extends SessionCandidate {
  score: number;
}

/** Field weights. Titles are the thing people actually remember, but they
 *  are auto-derived from the first 60 chars of the opening prompt, so a
 *  lot of them are truncated near-duplicates — matching the project and
 *  machine too is what makes "argus" or "codex" a useful query. */
const WEIGHT = {
  title: 1,
  project: 0.9,
  machine: 0.75,
  cliType: 0.7,
} as const;

/** Characters that start a new "word" for match-quality purposes. Paths
 *  and kebab/snake identifiers are most of what we match against. */
const BOUNDARY = /[\s/\\\-_.:]/;

/** Any subsequence hit scores below this, so a real substring match always
 *  outranks a scattered one. */
const SUBSEQUENCE_CEILING = 55;

/**
 * How well `query` matches `text`, or null for no match at all.
 *
 * Two tiers: a contiguous substring (strong, bonused for landing at a
 * prefix or word boundary), else a subsequence walk that rewards
 * consecutive characters and word-boundary hits. Deliberately small —
 * this runs over the whole hydrated session list on every keystroke, and
 * at a few hundred sessions that is far cheaper than a round-trip.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  if (!text) return null;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  const at = t.indexOf(q);
  if (at >= 0) {
    let score = 60;
    if (at === 0) score += 25;
    else if (BOUNDARY.test(t[at - 1]!)) score += 15;
    // Same match in a shorter field is the more specific one.
    score += Math.max(0, 12 - t.length / 10);
    return score;
  }

  let cursor = 0;
  let streak = 0;
  let score = 0;
  for (let i = 0; i < q.length; i++) {
    const found = t.indexOf(q[i]!, cursor);
    if (found < 0) return null;
    let point = 1;
    if (i > 0 && found === cursor) {
      streak += 1;
      point += streak * 2;
    } else {
      streak = 0;
    }
    if (found === 0 || BOUNDARY.test(t[found - 1]!)) point += 3;
    score += point;
    cursor = found + 1;
  }
  return Math.min(SUBSEQUENCE_CEILING, score);
}

/** Recency bonus, in the same units as the match score. Half-life of about
 *  ten days: ~35 for something touched today, ~17 a fortnight later, ~5 at
 *  six weeks. Additive rather than a tiebreak because a loose match on a
 *  session from this morning genuinely is the better answer than a tight
 *  match on one from March. */
function recencyBonus(updatedAt: string, now: number): number {
  const ts = Date.parse(updatedAt);
  if (Number.isNaN(ts)) return 0;
  const ageDays = Math.max(0, (now - ts) / 86_400_000);
  return 35 * Math.exp(-ageDays / 14);
}

function bestFieldScore(query: string, c: SessionCandidate): number | null {
  const fields: [string | null | undefined, number][] = [
    [c.session.title, WEIGHT.title],
    [c.projectLabel, WEIGHT.project],
    [c.machineName, WEIGHT.machine],
    [c.session.cliType, WEIGHT.cliType],
  ];
  let best: number | null = null;
  for (const [text, weight] of fields) {
    if (!text) continue;
    const s = fuzzyScore(query, text);
    if (s === null) continue;
    const weighted = s * weight;
    if (best === null || weighted > best) best = weighted;
  }
  return best;
}

/**
 * Rank sessions for the quick switcher.
 *
 * An empty query is the important case, not a degenerate one: it returns
 * the most-recently-updated live sessions so switching is two keystrokes
 * (⌘P, Enter). Archived sessions never appear there — with ~93% of
 * sessions archived they would bury the handful actually in play — but
 * they ARE reachable by typing, ranked strictly below every live match so
 * they can't displace one.
 */
export function rankSessions(
  query: string,
  candidates: SessionCandidate[],
  limit: number,
  now: number = Date.now(),
): RankedSession[] {
  const q = query.trim();

  if (!q) {
    return candidates
      .filter((c) => !c.session.archivedAt)
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
      .slice(0, limit)
      .map((c) => ({ ...c, score: 0 }));
  }

  const scored: RankedSession[] = [];
  for (const c of candidates) {
    const match = bestFieldScore(q, c);
    if (match === null) continue;
    scored.push({ ...c, score: match + recencyBonus(c.session.updatedAt, now) });
  }
  scored.sort((a, b) => {
    const aArchived = a.session.archivedAt ? 1 : 0;
    const bArchived = b.session.archivedAt ? 1 : 0;
    if (aArchived !== bArchived) return aArchived - bArchived;
    if (b.score !== a.score) return b.score - a.score;
    return b.session.updatedAt.localeCompare(a.session.updatedAt);
  });
  return scored.slice(0, limit);
}
