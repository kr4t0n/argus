package app.argus.core.model

import kotlinx.serialization.Serializable

// Mirrors packages/shared-types/src/api.ts (machines / projects) and
// protocol.ts (AvailableAdapter). The Agent entity was retired in the
// agent→runner refactor, so there is no AgentDTO here.

@Serializable
data class AvailableAdapter(
    val type: AgentType,
    val binary: String,
    /** Empty when `<binary> --version` couldn't be parsed. */
    val version: String = "",
)

@Serializable
data class MachineDTO(
    val id: String,
    val name: String,
    val hostname: String,
    val os: String,
    val arch: String,
    val sidecarVersion: String,
    val availableAdapters: List<AvailableAdapter> = emptyList(),
    val status: MachineStatus,
    val lastSeenAt: String,
    val registeredAt: String,
    val archivedAt: String? = null,
    val iconKey: String? = null,
)

/**
 * Server-side metadata for a "project" — the `(machineId, workingDir)`
 * pair the sidebar groups sessions under. Every promoted field is
 * optional so the decode stays tolerant of pre-promotion servers.
 */
@Serializable
data class ProjectDTO(
    val id: String,
    val machineId: String,
    val workingDir: String,
    /** User-picked label; null = client derives basename(workingDir). */
    val name: String? = null,
    /** Whether the project's runner exposes a PTY (drives the Terminal tab). */
    val supportsTerminal: Boolean? = null,
    /** ISO timestamp; null = active. */
    val archivedAt: String? = null,
    /** Null when active or for legacy archives without a snapshot. */
    val archiveSnapshot: ArchiveSnapshot? = null,
    val iconKey: String? = null,
) {
    /**
     * Restore snapshot captured by the client-side archive cascade —
     * only the ids the cascade flipped, so restore un-archives exactly
     * those and preserves individual archives made earlier.
     */
    @Serializable
    data class ArchiveSnapshot(
        /** Retained on the wire as `[]` since the Agent entity was retired. */
        val archivedAgentIds: List<String> = emptyList(),
        val archivedSessionIds: List<String> = emptyList(),
    )
}
