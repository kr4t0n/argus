package app.argus.core.model

import kotlinx.serialization.Serializable

// Wire enums, mirrored from packages/shared-types/src/protocol.ts.
//
// Every enum that arrives FROM the server decodes tolerantly: an
// unrecognized raw value becomes UNKNOWN instead of failing the whole
// payload. The server evolves ahead of shipped app builds, so decode
// tolerance is a hard requirement. Each enum names its own
// TolerantEnumSerializer explicitly (see JsonSupport.kt for why that is
// preferred over coerceInputValues + per-property defaults).

/**
 * `AgentType` is an open string by design ("AgentType is an open string
 * and the UI falls back to a generic icon for unknown types").
 */
typealias AgentType = String

object KnownAgentType {
    const val CLAUDE_CODE: AgentType = "claude-code"
    const val CODEX: AgentType = "codex"
    const val CURSOR_CLI: AgentType = "cursor-cli"
}

@Serializable(with = SessionStatus.Serializer::class)
enum class SessionStatus(override val wire: String) : WireEnum {
    ACTIVE("active"),
    IDLE("idle"),
    FAILED("failed"),
    UNKNOWN("unknown");

    internal object Serializer : TolerantEnumSerializer<SessionStatus>(
        "app.argus.core.SessionStatus", entries, UNKNOWN,
    )
}

@Serializable(with = MachineStatus.Serializer::class)
enum class MachineStatus(override val wire: String) : WireEnum {
    ONLINE("online"),
    OFFLINE("offline"),
    UNKNOWN("unknown");

    internal object Serializer : TolerantEnumSerializer<MachineStatus>(
        "app.argus.core.MachineStatus", entries, UNKNOWN,
    )
}

@Serializable(with = CommandStatus.Serializer::class)
enum class CommandStatus(override val wire: String) : WireEnum {
    PENDING("pending"),
    SENT("sent"),
    RUNNING("running"),
    COMPLETED("completed"),
    FAILED("failed"),
    CANCELLED("cancelled"),
    UNKNOWN("unknown");

    /**
     * True while the turn may still produce chunks. UNKNOWN counts as
     * non-terminal so a new server-side status never freezes a spinner
     * into a phantom "done".
     */
    val isTerminal: Boolean
        get() = when (this) {
            COMPLETED, FAILED, CANCELLED -> true
            PENDING, SENT, RUNNING, UNKNOWN -> false
        }

    internal object Serializer : TolerantEnumSerializer<CommandStatus>(
        "app.argus.core.CommandStatus", entries, UNKNOWN,
    )
}

@Serializable(with = CommandKind.Serializer::class)
enum class CommandKind(override val wire: String) : WireEnum {
    EXECUTE("execute"),
    CANCEL("cancel"),
    UNKNOWN("unknown");

    internal object Serializer : TolerantEnumSerializer<CommandKind>(
        "app.argus.core.CommandKind", entries, UNKNOWN,
    )
}

@Serializable(with = ResultKind.Serializer::class)
enum class ResultKind(override val wire: String) : WireEnum {
    DELTA("delta"),
    STDOUT("stdout"),
    STDERR("stderr"),
    TOOL("tool"),
    PROGRESS("progress"),
    FINAL("final"),
    ERROR("error"),
    UNKNOWN("unknown");

    internal object Serializer : TolerantEnumSerializer<ResultKind>(
        "app.argus.core.ResultKind", entries, UNKNOWN,
    )
}

/**
 * Which pass produced a `GET /search/sessions` page: the indexed
 * tsvector match, or the raw substring scan that runs only when full
 * text found nothing. Informational — clients render both the same way.
 */
@Serializable(with = SearchMode.Serializer::class)
enum class SearchMode(override val wire: String) : WireEnum {
    FULLTEXT("fulltext"),
    SUBSTRING("substring"),
    UNKNOWN("unknown");

    internal object Serializer : TolerantEnumSerializer<SearchMode>(
        "app.argus.core.SearchMode", entries, UNKNOWN,
    )
}
