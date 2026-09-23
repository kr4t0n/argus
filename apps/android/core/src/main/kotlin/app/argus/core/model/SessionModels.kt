package app.argus.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import app.argus.core.ArgusJson
import kotlinx.serialization.json.encodeToJsonElement

// Mirrors packages/shared-types/src/api.ts (sessions / commands / chunks /
// attachments) and protocol.ts (ResultChunk).
//
// Timestamps stay String (ISO-8601 with fractional seconds, as Prisma
// serializes them) — parse with ISO8601.parseMillis at display time
// instead of making every decode depend on a date strategy.

@Serializable
data class SessionDTO(
    val id: String,
    val userId: String,
    /**
     * The `(machineId, workingDir)` Project row this session is pinned
     * to. Null for the per-machine "no project" bucket (workdir-less).
     */
    val projectId: String? = null,
    /** CLI adapter type, denormalized onto the session at creation. */
    val cliType: AgentType? = null,
    val title: String,
    val externalId: String? = null,
    val status: SessionStatus,
    /** Unread-result marker, orthogonal to [status]. Sidebar dot iff true. */
    val unread: Boolean,
    /** Session-default model choice; null means "CLI default". */
    val modelSelection: ModelSelection? = null,
    val archivedAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

/**
 * Payload of the `session:status` WS event. [updatedAt] enables the
 * monotonic staleness guard: every status/unread write bumps the row's
 * updatedAt, so an older payload must never overwrite a newer one.
 */
@Serializable
data class SessionStatusEvent(
    val id: String,
    val status: SessionStatus,
    val unread: Boolean,
    val updatedAt: String,
)

@Serializable
data class AttachmentDTO(
    val id: String,
    val filename: String,
    val mime: String,
    val size: Long,
    /**
     * API-base-relative path incl. a short-lived token:
     * `/attachments/{id}?t={token}` — usable without an Authorization header.
     */
    val url: String,
    val createdAt: String,
)

/**
 * NOTE: the server also sends fields shared-types omits (e.g. a
 * denormalized `usage` on command rows). ArgusJson ignores unknown keys —
 * never add strictness that would reject them.
 */
@Serializable
data class CommandDTO(
    val id: String,
    val sessionId: String,
    val kind: CommandKind,
    val prompt: String? = null,
    val status: CommandStatus,
    /**
     * Merged adapter options the turn was dispatched with (ModelSelection
     * keys today). Absent for pre-feature rows / optionless turns.
     */
    val options: JsonObject? = null,
    val createdAt: String,
    val completedAt: String? = null,
    val attachments: List<AttachmentDTO>? = null,
)

/**
 * One streamed fragment of a turn. [seq] is monotonic PER COMMAND (the
 * sidecar resets it each turn); ordering is `(command.createdAt, seq)`.
 *
 * The same logical chunk arrives in two dressings (verified against a
 * live server — see the shared session-detail.json fixture):
 *   - WS `chunk` events relay the wire ResultChunk verbatim: carries
 *     `sessionId`/`isFinal`, `ts` is Unix millis (number);
 *   - REST rows come from Postgres: NO sessionId/isFinal columns
 *     (implied by the route), `ts` is an ISO string.
 * [EpochMillisSerializer] absorbs both for [ts]; the optional fields
 * default for the REST dressing.
 */
@Serializable
data class ResultChunk(
    val id: String,
    val commandId: String,
    /** Present on WS-relayed chunks only. */
    val sessionId: String? = null,
    val seq: Int,
    val kind: ResultKind,
    /** Incremental text; present for kind == DELTA. */
    val delta: String? = null,
    /** Full content for non-delta kinds. */
    val content: String? = null,
    /**
     * Raw upstream CLI event, verbatim. Everything adapter-specific
     * (usage, tool names, diffs, thinking) is parsed out of here.
     */
    val meta: JsonObject? = null,
    /** Unix millis. */
    @Serializable(with = EpochMillisSerializer::class)
    val ts: Long,
    /** False on REST rows (terminal-ness is re-derivable from [kind]). */
    val isFinal: Boolean = false,
)

typealias ResultChunkDTO = ResultChunk

// MARK: Requests

/**
 * Project-first addressing `{machineId, workingDir, cliType}` — the
 * server upserts the Project row for the pair and pins the session to
 * it. Nulls encode as absent keys (ArgusJson has explicitNulls = false).
 */
@Serializable
data class CreateSessionRequest(
    /** The target machine. */
    val machineId: String? = null,
    /** Project anchor. Empty/absent = the machine's "no project" bucket. */
    val workingDir: String? = null,
    val cliType: AgentType? = null,
    /** Capability flag for the project's runner (drives the Terminal tab). */
    val supportsTerminal: Boolean? = null,
    val title: String? = null,
    val prompt: String? = null,
    val modelSelection: ModelSelection? = null,
)

@Serializable
data class CreateCommandRequest(
    val prompt: String,
    val attachmentIds: List<String>? = null,
    val options: JsonObject? = null,
)

/**
 * PATCH /sessions/:id/model — `modelSelection: null` (an explicit JSON
 * null, not an absent key) clears back to "CLI default". ArgusJson omits
 * null properties, so this body is built as a JsonObject whose JsonNull
 * element is always written.
 */
data class UpdateSessionModelRequest(val modelSelection: ModelSelection?) {
    fun toJson(): JsonObject = buildJsonObject {
        put(
            "modelSelection",
            modelSelection?.let { ArgusJson.encodeToJsonElement(it) } ?: JsonNull,
        )
    }
}

// MARK: Responses

/** `GET /sessions/:id` — initial load (tail window) or afterSeq backfill. */
@Serializable
data class SessionDetailResponse(
    val session: SessionDTO,
    val commands: List<CommandDTO>,
    val chunks: List<ResultChunk>,
    val hasMore: Boolean,
)

/** `GET /sessions/:id/chunks?afterSeq=` — reconnect delta fetch. */
@Serializable
data class SessionChunksResponse(
    val commands: List<CommandDTO>,
    val chunks: List<ResultChunk>,
)

/** `GET /sessions/:id/history?before=&limit=` — scroll-up pagination. */
@Serializable
data class SessionHistoryResponse(
    val commands: List<CommandDTO>,
    val chunks: List<ResultChunk>,
    val hasMore: Boolean,
)

/**
 * `POST /sessions` — [command] is non-null when the request carried an
 * initial prompt (the first turn is dispatched inline).
 */
@Serializable
data class CreateSessionResponse(
    val session: SessionDTO,
    val command: CommandDTO? = null,
)

// MARK: Session content search (`GET /search/sessions`)

/**
 * One matching session. The server returns the single best-ranked turn
 * per session (so one chatty session can't crowd out the results) plus
 * how many of its turns matched. Session metadata — title, project,
 * machine — is deliberately absent: every client already holds the
 * full session list, so re-sending it per hit would be redundant.
 */
@Serializable
data class SessionSearchHitDTO(
    val sessionId: String,
    /**
     * The best-matching turn. The web deep-links to it (`?turn=`); the
     * native clients open the session at its tail — see AGENTS.md.
     */
    val commandId: String,
    /** Total matching turns in this session, not just the one shown. */
    val matchCount: Int,
    /**
     * Text window around the match, with terms wrapped in the
     * `SearchSnippet` highlight sentinels (`[[hl]]` / `[[/hl]]`).
     */
    val snippet: String,
)

@Serializable
data class SessionSearchResponse(
    /** The trimmed query the server actually ran. */
    val query: String,
    val hits: List<SessionSearchHitDTO>,
    val mode: SearchMode,
)
