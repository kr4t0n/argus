package app.argus.core

import app.argus.core.model.AttachmentDTO
import app.argus.core.model.CommandDTO
import app.argus.core.model.CommandKind
import app.argus.core.model.CommandStatus
import app.argus.core.model.ResultChunk
import app.argus.core.model.ResultKind
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionStatus
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.util.UUID

// Shared builders and fixture access for :core tests — the counterpart of
// ArgusKit's TestSupport.swift.

fun testChunk(
    id: String = UUID.randomUUID().toString(),
    commandId: String = "cmd-1",
    sessionId: String? = "sess-1",
    seq: Int,
    kind: ResultKind,
    delta: String? = null,
    content: String? = null,
    meta: JsonObject? = null,
    isFinal: Boolean = false,
): ResultChunk = ResultChunk(
    id = id,
    commandId = commandId,
    sessionId = sessionId,
    seq = seq,
    kind = kind,
    delta = delta,
    content = content,
    meta = meta,
    ts = 1_750_000_000_000L + seq,
    isFinal = isFinal,
)

fun testCommand(
    id: String = "cmd-1",
    sessionId: String = "sess-1",
    kind: CommandKind = CommandKind.EXECUTE,
    prompt: String? = "do the thing",
    status: CommandStatus = CommandStatus.RUNNING,
    createdAt: String = "2026-07-05T10:00:00.000Z",
    attachmentIds: List<String>? = null,
): CommandDTO = CommandDTO(
    id = id,
    sessionId = sessionId,
    kind = kind,
    prompt = prompt,
    status = status,
    createdAt = createdAt,
    completedAt = null,
    attachments = attachmentIds?.map { attachmentId ->
        AttachmentDTO(
            id = attachmentId,
            filename = "$attachmentId.png",
            mime = "image/png",
            size = 1,
            url = "/attachments/$attachmentId?t=T",
            createdAt = "2026-07-05T10:00:00.000Z",
        )
    },
)

fun testSession(
    id: String = "sess-1",
    title: String = "Session",
    cliType: String? = "claude-code",
    projectId: String? = null,
    status: SessionStatus = SessionStatus.IDLE,
    unread: Boolean = false,
    updatedAt: String = "2026-07-05T10:00:00.000Z",
    archivedAt: String? = null,
): SessionDTO = SessionDTO(
    id = id,
    userId = "u1",
    projectId = projectId,
    cliType = cliType,
    title = title,
    externalId = null,
    status = status,
    unread = unread,
    archivedAt = archivedAt,
    createdAt = "2026-07-05T10:00:00.000Z",
    updatedAt = updatedAt,
)

/** Parse a JSON object literal into a [JsonObject] (for chunk `meta`). */
fun metaOf(json: String): JsonObject = ArgusJson.parseToJsonElement(json).jsonObject

/**
 * The repository root. Gradle passes it as a system property
 * (core/build.gradle.kts); the walk-up fallback keeps the tests runnable
 * from an IDE that doesn't.
 */
fun repoRoot(): File {
    System.getProperty("argus.repoRoot")?.let { return File(it) }
    var dir: File? = File(System.getProperty("user.dir")).absoluteFile
    while (dir != null) {
        if (File(dir, "pnpm-workspace.yaml").isFile) return dir
        dir = dir.parentFile
    }
    error("could not locate the repository root (no pnpm-workspace.yaml above ${System.getProperty("user.dir")})")
}

/**
 * The fixture directory shared with ArgusKit's FixtureDecodingTests —
 * sanitized live-server responses written by scripts/capture-client-fixtures.sh.
 */
fun fixturesDir(): File =
    System.getProperty("argus.fixtures")?.let { File(it) }
        ?: File(repoRoot(), "packages/shared-types/fixtures")

/**
 * For fixtures that are captured on demand — a test that needs one
 * skips (visibly, via an Assume) until the capture script has been run
 * against a server that can produce it.
 */
fun hasFixture(name: String): Boolean = File(fixturesDir(), "$name.json").isFile

fun fixtureText(name: String): String {
    val file = File(fixturesDir(), "$name.json")
    check(file.isFile) { "missing fixture $name.json under ${fixturesDir()}" }
    return file.readText()
}

inline fun <reified T> decodeFixture(name: String): T = ArgusJson.decodeFromString<T>(fixtureText(name))
