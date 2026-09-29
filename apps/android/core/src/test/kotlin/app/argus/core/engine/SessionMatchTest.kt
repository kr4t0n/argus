package app.argus.core.engine

import app.argus.core.model.ISO8601
import app.argus.core.testSession
import java.util.UUID
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/SessionMatchTests.swift —
// "SessionMatch — port of apps/web/src/lib/sessionMatch.ts". Every case
// and expectation is kept 1:1 so the three clients rank alike.

class SessionMatchTest {
    private companion object {
        /** Fixed clock so recency is deterministic. */
        val now: Long = ISO8601.parseMillis("2026-09-21T12:00:00.000Z")!!
        const val today = "2026-09-21T11:00:00.000Z"
        const val lastMonth = "2026-08-01T11:00:00.000Z"
    }

    private fun candidate(
        title: String,
        id: String = UUID.randomUUID().toString(),
        project: String? = null,
        machine: String? = null,
        cliType: String? = "claude-code",
        updatedAt: String = today,
        archived: Boolean = false,
    ): SessionCandidate = SessionCandidate(
        session = testSession(
            id = id,
            title = title,
            cliType = cliType,
            updatedAt = updatedAt,
            archivedAt = if (archived) "2026-09-20T00:00:00.000Z" else null,
        ),
        projectLabel = project,
        machineName = machine,
    )

    private fun rank(query: String, candidates: List<SessionCandidate>, limit: Int = 12): List<String> =
        SessionMatch.rank(query = query, candidates = candidates, limit = limit, now = now)
            .map { it.session.title }

    // MARK: fuzzyScore

    /** A contiguous substring always outranks a scattered subsequence. */
    @Test
    fun substringBeatsSubsequence() {
        val substring = assertNotNull(SessionMatch.fuzzyScore(query = "argus", text = "fix the argus sidebar"))
        val subsequence = assertNotNull(SessionMatch.fuzzyScore(query = "ags", text = "argus"))
        assertTrue(substring > subsequence)
        assertTrue(subsequence <= SessionMatch.subsequenceCeiling)
        assertTrue(substring >= 60)
    }

    /** Prefix > word boundary > mid-word for the same substring. */
    @Test
    fun positionBonuses() {
        val prefix = assertNotNull(SessionMatch.fuzzyScore(query = "side", text = "sidebar fix"))
        val boundary = assertNotNull(SessionMatch.fuzzyScore(query = "side", text = "fix sidebar"))
        val mid = assertNotNull(SessionMatch.fuzzyScore(query = "bar", text = "sidebar"))
        assertTrue(prefix > boundary)
        assertTrue(boundary > mid)
    }

    /** Path separators and kebab/snake dashes count as word boundaries. */
    @Test
    fun identifierBoundaries() {
        val slash = assertNotNull(SessionMatch.fuzzyScore(query = "web", text = "apps/web"))
        val dash = assertNotNull(SessionMatch.fuzzyScore(query = "code", text = "claude-code"))
        val plain = assertNotNull(SessionMatch.fuzzyScore(query = "code", text = "encoder"))
        assertTrue(slash > 60 + 12) // boundary bonus landed
        assertTrue(dash > plain)
    }

    /** Case-insensitive; empty query scores 0; empty text is no match. */
    @Test
    fun edges() {
        assertEquals(
            SessionMatch.fuzzyScore(query = "ARGUS", text = "argus"),
            SessionMatch.fuzzyScore(query = "argus", text = "ARGUS"),
        )
        assertEquals(0.0, SessionMatch.fuzzyScore(query = "", text = "anything"))
        assertNull(SessionMatch.fuzzyScore(query = "x", text = ""))
        assertNull(SessionMatch.fuzzyScore(query = "xyz", text = "argus"))
    }

    // MARK: rank

    /** Empty query lists live sessions newest first, capped, never archived. */
    @Test
    fun emptyQueryIsRecents() {
        val candidates = listOf(
            candidate("old", updatedAt = "2026-09-01T00:00:00.000Z"),
            candidate("newest", updatedAt = "2026-09-21T10:00:00.000Z"),
            candidate("archived-newer", updatedAt = "2026-09-21T11:00:00.000Z", archived = true),
            candidate("middle", updatedAt = "2026-09-10T00:00:00.000Z"),
        )
        assertEquals(listOf("newest", "middle", "old"), rank("", candidates))
        assertEquals(listOf("newest", "middle", "old"), rank("   ", candidates))
        assertEquals(listOf("newest", "middle"), rank("", candidates, limit = 2))
        assertTrue(
            SessionMatch.rank(query = "", candidates = candidates, limit = 5, now = now)
                .all { it.score == 0.0 },
        )
    }

    /** Archived sessions rank strictly below every live match, even a better one. */
    @Test
    fun archivedSinkBelowLive() {
        val candidates = listOf(
            // Exact prefix match, touched today — the better match by score.
            candidate("argus", updatedAt = today, archived = true),
            // Weaker (mid-boundary) match, a month old.
            candidate("notes on argus", updatedAt = lastMonth),
        )
        assertEquals(listOf("notes on argus", "argus"), rank("argus", candidates))
    }

    /** Sessions matching no field are excluded. */
    @Test
    fun noMatchExcluded() {
        val candidates = listOf(candidate("deploy pipeline"), candidate("argus sidebar"))
        assertTrue(rank("zzz", candidates).isEmpty())
        assertEquals(listOf("argus sidebar"), rank("argus", candidates))
    }

    /** Recency is additive: the same match quality ranks the newer session first. */
    @Test
    fun recencyBreaksTies() {
        val candidates = listOf(
            candidate("argus", updatedAt = lastMonth),
            candidate("argus", id = "b", updatedAt = today),
        )
        val ranked = SessionMatch.rank(query = "argus", candidates = candidates, limit = 5, now = now)
        assertEquals("b", ranked.map { it.id }.first())
        // ~35 today, decaying with a ~10-day half-life; unparseable = 0.
        assertTrue(abs(SessionMatch.recencyBonus(updatedAt = today, now = now) - 35) < 0.5)
        assertEquals(0.0, SessionMatch.recencyBonus(updatedAt = "not a date", now = now))
        assertTrue(SessionMatch.recencyBonus(updatedAt = lastMonth, now = now) < 5)
    }

    /** Title outranks a machine-name match of equal quality (field weights). */
    @Test
    fun fieldWeights() {
        val candidates = listOf(
            candidate("zzz", machine = "argus"),
            candidate("argus", id = "title-hit"),
        )
        val ranked = SessionMatch.rank(query = "argus", candidates = candidates, limit = 5, now = now)
        assertEquals("title-hit", ranked.map { it.id }.first())
    }

    /** Project, machine and cliType are all matchable. */
    @Test
    fun matchesEveryField() {
        val candidates = listOf(
            candidate("untitled one", id = "by-project", project = "argus"),
            candidate("untitled two", id = "by-machine", machine = "gpu-box"),
            candidate("untitled three", id = "by-cli", cliType = "codex"),
        )
        assertEquals(listOf("untitled one"), rank("argus", candidates))
        assertEquals(listOf("untitled two"), rank("gpu", candidates))
        assertEquals(listOf("untitled three"), rank("codex", candidates))
    }

    /** Limit caps the scored list too. */
    @Test
    fun limitApplies() {
        val candidates = (0 until 20).map { candidate("argus $it", id = "s$it") }
        assertEquals(3, rank("argus", candidates, limit = 3).size)
        assertTrue(rank("argus", candidates, limit = 0).isEmpty())
    }
}
