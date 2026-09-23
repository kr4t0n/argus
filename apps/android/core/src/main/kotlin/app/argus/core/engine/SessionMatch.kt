package app.argus.core.engine

import app.argus.core.model.ISO8601
import app.argus.core.model.SessionDTO
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/SessionMatch.swift,
// itself a port of apps/web/src/lib/sessionMatch.ts (the ⌘P / Ctrl+P
// session-switcher ranking). Keep all three in lockstep: the weights,
// bonuses and tie-breaks here ARE the web's, so the same query ranks the
// same session first on every client.
//
// Pure: the caller assembles SessionCandidates from the stores it already
// holds (the whole session list is hydrated at boot), and nothing here
// touches the network — at a few hundred sessions a per-keystroke rank is
// far cheaper than a round-trip.
//
// Unlike the Swift port, this file follows the TS original EXACTLY on
// string arithmetic: Kotlin strings are UTF-16 code units like
// JavaScript's, so `indexOf`, `length` and the boundary lookup at
// `t[at - 1]` agree with the web byte-for-byte, including the small
// length-specificity bonus on non-BMP text that Swift (grapheme-based)
// computes slightly differently. Do not "fix" this to iterate code points.

/**
 * One session plus the derived labels the switcher matches against.
 * Assembled by the caller, which already holds the project/machine
 * stores — this module stays pure so it can be reasoned about (and
 * scored) without any store wiring.
 */
data class SessionCandidate(
    val session: SessionDTO,
    /**
     * The project's display label — its picked name, else the working
     * directory's basename. Null for workdir-less sessions and for rows
     * whose Project hasn't hydrated.
     */
    val projectLabel: String?,
    val machineName: String?,
    /**
     * The machine these labels name has been soft-deleted. Rendering
     * only — scoring ignores it, so a removed machine's sessions stay
     * matchable by project and host exactly like live ones. That
     * searchability is the point: search is how deleted machines'
     * history is reached at all.
     */
    val removed: Boolean = false,
)

data class RankedSession(
    val candidate: SessionCandidate,
    val score: Double,
) {
    val id: String get() = candidate.session.id
    val session: SessionDTO get() = candidate.session
}

object SessionMatch {
    /**
     * Field weights. Titles are the thing people actually remember, but
     * they are auto-derived from the first 60 chars of the opening
     * prompt, so a lot of them are truncated near-duplicates — matching
     * the project and machine too is what makes "argus" or "codex" a
     * useful query.
     */
    internal const val titleWeight = 1.0
    internal const val projectWeight = 0.9
    internal const val machineWeight = 0.75
    internal const val cliTypeWeight = 0.7

    /**
     * Any subsequence hit scores below this, so a real substring match
     * always outranks a scattered one.
     */
    internal const val subsequenceCeiling = 55.0

    /**
     * Characters that start a new "word" for match-quality purposes.
     * Paths and kebab/snake identifiers are most of what we match
     * against. (The TS original's `/[\s/\\\-_.:]/`; `\s` in JavaScript is
     * Unicode whitespace, which is what [Char.isWhitespace] answers too.)
     */
    internal fun isBoundary(character: Char): Boolean =
        character.isWhitespace() ||
            character == '/' || character == '\\' ||
            character == '-' || character == '_' ||
            character == '.' || character == ':'

    /**
     * How well [query] matches [text], or null for no match at all.
     *
     * Two tiers: a contiguous substring (strong, bonused for landing at
     * a prefix or word boundary), else a subsequence walk that rewards
     * consecutive characters and word-boundary hits. Deliberately small —
     * this runs over the whole hydrated session list on every keystroke.
     */
    fun fuzzyScore(query: String, text: String): Double? {
        if (query.isEmpty()) return 0.0
        if (text.isEmpty()) return null
        val q = query.lowercase()
        val t = text.lowercase()

        val at = t.indexOf(q)
        if (at >= 0) {
            var score = 60.0
            if (at == 0) {
                score += 25.0
            } else if (isBoundary(t[at - 1])) {
                score += 15.0
            }
            // Same match in a shorter field is the more specific one.
            score += max(0.0, 12.0 - t.length / 10.0)
            return score
        }

        var cursor = 0
        var streak = 0
        var score = 0.0
        for (i in q.indices) {
            val found = t.indexOf(q[i], cursor)
            if (found < 0) return null
            var point = 1.0
            if (i > 0 && found == cursor) {
                streak += 1
                point += streak * 2.0
            } else {
                streak = 0
            }
            if (found == 0 || isBoundary(t[found - 1])) point += 3.0
            score += point
            cursor = found + 1
        }
        return min(subsequenceCeiling, score)
    }

    /**
     * Recency bonus, in the same units as the match score. Half-life of
     * about ten days: ~35 for something touched today, ~13 a fortnight
     * later, ~2 at six weeks. Additive rather than a tiebreak because a
     * loose match on a session from this morning genuinely is the better
     * answer than a tight match on one from March.
     *
     * [now] is Unix millis (the TS `Date.now()` shape); an unparseable
     * [updatedAt] earns 0, never a throw.
     */
    internal fun recencyBonus(updatedAt: String, now: Long): Double {
        val ts = ISO8601.parseMillis(updatedAt) ?: return 0.0
        val ageDays = max(0.0, (now - ts) / 86_400_000.0)
        return 35.0 * exp(-ageDays / 14.0)
    }

    internal fun bestFieldScore(query: String, candidate: SessionCandidate): Double? {
        val fields: List<Pair<String?, Double>> = listOf(
            candidate.session.title to titleWeight,
            candidate.projectLabel to projectWeight,
            candidate.machineName to machineWeight,
            candidate.session.cliType to cliTypeWeight,
        )
        var best: Double? = null
        for ((text, weight) in fields) {
            if (text.isNullOrEmpty()) continue
            val score = fuzzyScore(query, text) ?: continue
            val weighted = score * weight
            val current = best
            if (current != null && weighted <= current) continue
            best = weighted
        }
        return best
    }

    /**
     * Rank sessions for the quick switcher.
     *
     * An empty query is the important case, not a degenerate one: it
     * returns the most-recently-updated live sessions so switching is
     * two keystrokes (⌘P, Enter). Archived sessions never appear there
     * — with ~93% of sessions archived they would bury the handful
     * actually in play — but they ARE reachable by typing, ranked
     * strictly below every live match so they can't displace one.
     *
     * [now] is Unix millis and exists so tests can pin the recency clock.
     */
    fun rank(
        query: String,
        candidates: List<SessionCandidate>,
        limit: Int,
        now: Long = System.currentTimeMillis(),
    ): List<RankedSession> {
        val q = query.trim()
        val cap = max(0, limit)

        if (q.isEmpty()) {
            return candidates
                .filter { it.session.archivedAt == null }
                .sortedByDescending { it.session.updatedAt }
                .take(cap)
                .map { RankedSession(candidate = it, score = 0.0) }
        }

        val scored = ArrayList<RankedSession>()
        for (candidate in candidates) {
            val match = bestFieldScore(q, candidate) ?: continue
            val bonus = recencyBonus(candidate.session.updatedAt, now)
            scored.add(RankedSession(candidate = candidate, score = match + bonus))
        }
        // Live before archived, then score, then newest — a stable sort,
        // like the Swift and JS originals, so equal rows keep input order.
        scored.sortWith(
            compareBy<RankedSession> { it.session.archivedAt != null }
                .thenByDescending { it.score }
                .thenByDescending { it.session.updatedAt },
        )
        return scored.take(cap)
    }
}
