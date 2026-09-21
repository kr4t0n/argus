package app.argus.core

import app.argus.core.engine.TranscriptState
import app.argus.core.model.CommandStatus
import app.argus.core.model.FSEntryKind
import app.argus.core.model.FSListResponse
import app.argus.core.model.GitLogResponse
import app.argus.core.model.KnownAgentType
import app.argus.core.model.LoginResponse
import app.argus.core.model.MachineDTO
import app.argus.core.model.ModelCatalogResponse
import app.argus.core.model.ProjectDTO
import app.argus.core.model.ResultKind
import app.argus.core.model.SearchMode
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionDetailResponse
import app.argus.core.model.SessionSearchResponse
import app.argus.core.model.SessionStatus
import app.argus.core.model.UserExtensions
import app.argus.core.model.UserQuotaResponse
import app.argus.core.model.UserUsageResponse
import org.junit.Assume.assumeTrue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Decode REAL server responses captured by
 * `scripts/capture-client-fixtures.sh` into the directory shared with
 * ArgusKit's FixtureDecodingTests. This suite is the contract check: when
 * packages/shared-types changes shape, re-run the capture script against
 * a live server and these tests tell you whether the Kotlin mirror still
 * holds.
 */
class FixtureDecodingTest {
    @Test
    fun `login json decodes to LoginResponse`() {
        val response = decodeFixture<LoginResponse>("login")
        assertTrue(response.user.id.isNotEmpty())
        assertEquals("admin", response.user.role)
    }

    @Test
    fun `sessions json decodes to a list of SessionDTO`() {
        val sessions = decodeFixture<List<SessionDTO>>("sessions")
        assertTrue(sessions.isNotEmpty())
        for (session in sessions) {
            assertTrue(session.id.isNotEmpty())
            assertTrue(session.status != SessionStatus.UNKNOWN)
        }
    }

    @Test
    fun `machines json decodes to a list of MachineDTO`() {
        val machines = decodeFixture<List<MachineDTO>>("machines")
        assertTrue(machines.isNotEmpty())
        assertTrue(machines[0].availableAdapters.all { it.type.isNotEmpty() })
    }

    @Test
    fun `projects json decodes to a list of ProjectDTO`() {
        val projects = decodeFixture<List<ProjectDTO>>("projects")
        assertTrue(projects.all { it.workingDir.isNotEmpty() })
    }

    @Test
    fun `me-usage json decodes to UserUsageResponse`() {
        val response = decodeFixture<UserUsageResponse>("me-usage")
        assertTrue(response.usage.lifetime.inputTokens >= 0)
    }

    @Test
    fun `me-quota json decodes to UserQuotaResponse`() {
        val response = decodeFixture<UserQuotaResponse>("me-quota")
        assertTrue(response.quotas.all { it.type.isNotEmpty() })
    }

    @Test
    fun `me-extensions json decodes to UserExtensions`() {
        decodeFixture<UserExtensions>("me-extensions")
    }

    @Test
    fun `model-catalog json decodes to ModelCatalogResponse`() {
        val response = decodeFixture<ModelCatalogResponse>("model-catalog")
        assertTrue(response.models.isNotEmpty())
        assertTrue(response.models.all { it.id.isNotEmpty() })
    }

    // git-log / fs-list are answered live by the sidecar, so the capture
    // script only writes them when the session's machine is online —
    // gated like the search fixture rather than failing on a quiet fleet.
    @Test
    fun `git-log json decodes to GitLogResponse`() {
        assumeTrue(hasFixture("git-log"))
        val response = decodeFixture<GitLogResponse>("git-log")
        assertTrue(response.commits.all { it.sha.length == 40 && it.subject.isNotEmpty() })
    }

    @Test
    fun `fs-list json decodes to FSListResponse`() {
        assumeTrue(hasFixture("fs-list"))
        val response = decodeFixture<FSListResponse>("fs-list")
        assertTrue(response.entries.all { it.name.isNotEmpty() && it.kind != FSEntryKind.UNKNOWN })
    }

    @Test
    fun `search-sessions json decodes to SessionSearchResponse`() {
        assumeTrue(hasFixture("search-sessions"))
        val response = decodeFixture<SessionSearchResponse>("search-sessions")
        assertTrue(response.query.isNotEmpty())
        assertTrue(response.mode != SearchMode.UNKNOWN)
        assertTrue(response.hits.all { it.sessionId.isNotEmpty() && it.commandId.isNotEmpty() })
    }

    @Test
    fun `session-detail json decodes to SessionDetailResponse`() {
        val detail = decodeFixture<SessionDetailResponse>("session-detail")
        assertTrue(detail.commands.isNotEmpty())
        assertTrue(detail.chunks.isNotEmpty())

        // REST chunks: ISO-string ts must have parsed to real millis, and
        // the absent sessionId/isFinal must not have broken decode.
        assertTrue(detail.chunks.all { it.ts > 0 })
        detail.chunks.forEach { assertNull(it.sessionId) }
        assertTrue(detail.chunks.all { it.kind != ResultKind.UNKNOWN })
        assertTrue(detail.chunks.none { it.isFinal })

        // End-to-end: the transcript engine builds turns from real data.
        val state = TranscriptState(detail.session.id)
        state.applySnapshot(commands = detail.commands, chunks = detail.chunks, hasMore = detail.hasMore)
        val turns = state.turns(KnownAgentType.CLAUDE_CODE)
        assertTrue(turns.isNotEmpty())
        // A completed turn CAN legitimately be empty (Redis MAXLEN
        // trimming is a documented chunk-loss mode — the captured data
        // contains exactly such a turn: one bare content-less `final`).
        // Assert the properties the data does guarantee instead.
        val completed = turns.filter { it.status == CommandStatus.COMPLETED }
        assertTrue(completed.any { it.answer.isNotEmpty() })
        val failed = turns.filter { it.status == CommandStatus.FAILED }
        assertTrue(failed.all { it.errorText != null })
    }
}
