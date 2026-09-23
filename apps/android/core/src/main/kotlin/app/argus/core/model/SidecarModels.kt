package app.argus.core.model

import kotlinx.serialization.Serializable

// Mirrors packages/shared-types/src/api.ts (sidecar version + remote
// update section) and the terminal DTO.

/**
 * `GET /machines/:id/sidecar/version`. [latest] comes from a ~30-min
 * server-side cache of the GitHub release tag.
 */
@Serializable
data class SidecarVersionInfo(
    val current: String,
    val latest: String? = null,
    val latestCheckedAt: String? = null,
    val updateAvailable: Boolean = false,
)

/**
 * 202 body for `POST /machines/:id/sidecar/update`. The loop closes
 * when the machine re-registers with the new version (machine:upsert).
 */
@Serializable
data class SidecarUpdateAccepted(
    val requestId: String,
    val machineId: String,
    val fromVersion: String = "",
)

/**
 * Mirrors api.ts (terminals). The PTY is project-scoped and opt-in via
 * the project's `supportsTerminal`; the server scopes terminals to the
 * opening user and rejects opens on offline machines or projects without
 * a PTY runner. [status] is 'opening' | 'open' | 'closed' | 'error' —
 * an open string for tolerance.
 */
@Serializable
data class TerminalDTO(
    val id: String,
    val userId: String,
    val status: String,
    val shell: String = "",
    val cwd: String? = null,
    val cols: Int = 0,
    val rows: Int = 0,
    val exitCode: Int? = null,
    val closeReason: String? = null,
    val openedAt: String = "",
    val closedAt: String? = null,
)
