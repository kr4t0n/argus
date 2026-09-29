package app.argus.core.realtime

import app.argus.core.model.CommandDTO
import app.argus.core.model.MachineDTO
import app.argus.core.model.ProjectDTO
import app.argus.core.model.ResultChunk
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionStatusEvent
import app.argus.core.model.TerminalDTO
import kotlinx.serialization.Serializable

// Event payloads for the `/stream` namespace, against the event map in
// packages/shared-types/src/ws.ts. Small payloads for events that don't
// carry a full DTO live here too.

@Serializable
data class IdStatusPayload(val id: String, val status: String)

@Serializable
data class IdPayload(val id: String)

@Serializable
data class SessionCloneFailedPayload(val sessionId: String, val reason: String = "")

/**
 * fs/git nudges are scoped to the `(machineId, workingDir)` project the
 * runner emitted them for; panels match on that pair. Both fields
 * optional for tolerance — a dropped identity must degrade matching,
 * never decoding.
 */
@Serializable
data class FSChangedPayload(
    val path: String = "",
    val machineId: String? = null,
    val workingDir: String? = null,
)

@Serializable
data class GitChangedPayload(
    val machineId: String? = null,
    val workingDir: String? = null,
)

/**
 * One chunk of PTY output. [data] is base64 raw bytes; [seq] is the
 * duplicate guard (feed strictly increasing seqs only).
 */
@Serializable
data class TerminalOutputPayload(
    val terminalId: String,
    val seq: Long,
    val data: String,
)

@Serializable
data class TerminalClosedPayload(
    val terminalId: String,
    val exitCode: Int? = null,
    val reason: String? = null,
)

/**
 * One live event from the `/stream` namespace. The connection-state
 * members ([Connected], [Disconnected], [SocketError]) come from the
 * socket itself; everything else is a decoded server event.
 */
sealed interface ServerEvent {
    data object Connected : ServerEvent
    data object Disconnected : ServerEvent
    data class SocketError(val message: String) : ServerEvent

    data class Chunk(val chunk: ResultChunk) : ServerEvent
    data class CommandCreated(val command: CommandDTO) : ServerEvent
    data class CommandUpdated(val command: CommandDTO) : ServerEvent

    data class SessionCreated(val session: SessionDTO) : ServerEvent
    data class SessionUpdated(val session: SessionDTO) : ServerEvent
    data class SessionStatusChanged(val event: SessionStatusEvent) : ServerEvent
    data class SessionCloneFailed(val payload: SessionCloneFailedPayload) : ServerEvent

    data class MachineUpsert(val machine: MachineDTO) : ServerEvent
    data class MachineStatusChanged(val payload: IdStatusPayload) : ServerEvent
    data class MachineRemoved(val payload: IdPayload) : ServerEvent

    data class ProjectUpsert(val project: ProjectDTO) : ServerEvent

    data class FsChanged(val payload: FSChangedPayload) : ServerEvent
    data class GitChanged(val payload: GitChangedPayload) : ServerEvent

    /**
     * created/updated arrive on the user room; output/closed on the
     * `terminal:{id}` room (`subscribe:terminal`).
     */
    data class TerminalCreated(val terminal: TerminalDTO) : ServerEvent
    data class TerminalUpdated(val terminal: TerminalDTO) : ServerEvent
    data class TerminalOutput(val payload: TerminalOutputPayload) : ServerEvent
    data class TerminalClosed(val payload: TerminalClosedPayload) : ServerEvent
}
