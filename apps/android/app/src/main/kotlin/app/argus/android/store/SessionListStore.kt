package app.argus.android.store

import app.argus.core.engine.ProjectGroup
import app.argus.core.engine.ProjectGroups
import app.argus.core.engine.SessionCandidate
import app.argus.core.model.MachineDTO
import app.argus.core.model.ProjectDTO
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionStatusEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * All sessions the user owns, with the monotonic-updatedAt guard the web
 * uses so a stale REST response can't resurrect a cleared unread dot
 * (port of SessionListStore in apps/ios/Argus/Sources/Stores.swift).
 * Main-thread only.
 */
class SessionListStore {
    private val _sessions = MutableStateFlow<Map<String, SessionDTO>>(emptyMap())
    val sessions: StateFlow<Map<String, SessionDTO>> = _sessions.asStateFlow()

    private val _loaded = MutableStateFlow(false)
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    fun reset() {
        _sessions.value = emptyMap()
        _loaded.value = false
    }

    fun setAll(list: List<SessionDTO>) {
        // Merge row-by-row through the staleness guard: a WS status may
        // have landed while the GET was in flight. Rows the server no
        // longer returns are dropped (hard-deleted; archived rows ARE
        // returned — lists load with includeArchived).
        val merged = LinkedHashMap<String, SessionDTO>()
        val current = _sessions.value
        for (session in list) {
            val existing = current[session.id]
            merged[session.id] = if (existing != null && existing.updatedAt > session.updatedAt) existing else session
        }
        _sessions.value = merged
        _loaded.value = true
    }

    fun upsert(session: SessionDTO) {
        val existing = _sessions.value[session.id]
        if (existing != null && existing.updatedAt > session.updatedAt) return
        _sessions.value = _sessions.value + (session.id to session)
    }

    fun applyStatus(event: SessionStatusEvent) {
        val session = _sessions.value[event.id] ?: return
        if (event.updatedAt < session.updatedAt) return
        _sessions.value = _sessions.value +
            (event.id to session.copy(status = event.status, unread = event.unread, updatedAt = event.updatedAt))
    }

    /**
     * Optimistically clear the dot the moment the user opens a session
     * (the server confirms via a session:status echo).
     */
    fun markSeenLocally(id: String) {
        val session = _sessions.value[id] ?: return
        if (!session.unread) return
        _sessions.value = _sessions.value + (id to session.copy(unread = false))
    }

    /** Sessions grouped into projects with the shared ordering rule. */
    fun projectGroups(fleet: FleetStore): List<ProjectGroup> =
        ProjectGroups.group(_sessions.value.values, fleet.projects.value, fleet.machines.value)

    /**
     * Candidates for the Ctrl+P switcher: every session plus the labels
     * the ranker matches against (the web palette's candidate build).
     * Labels resolve through the session's Project row exactly like
     * [projectGroups]; a session whose row is missing still ranks by
     * title and cliType.
     */
    fun searchCandidates(fleet: FleetStore): List<SessionCandidate> {
        val projectsById = fleet.projects.value.values.associateBy { it.id }
        val machines = fleet.machines.value
        return _sessions.value.values.map { searchCandidate(it, projectsById, machines) }
    }

    /** Single-row form of [searchCandidates] (a Ctrl+K hit's trailing label). */
    fun searchCandidate(session: SessionDTO, fleet: FleetStore): SessionCandidate =
        searchCandidate(session, fleet.projects.value.values.associateBy { it.id }, fleet.machines.value)

    private fun searchCandidate(
        session: SessionDTO,
        projectsById: Map<String, ProjectDTO>,
        machines: Map<String, MachineDTO>,
    ): SessionCandidate {
        val project = session.projectId?.let { projectsById[it] }
        var projectLabel: String? = null
        var machineName: String? = null
        if (project != null) {
            val name = project.name
            projectLabel = if (!name.isNullOrEmpty()) {
                name
            } else {
                ProjectGroups.basename(project.workingDir).ifEmpty { null }
            }
            machineName = machines[project.machineId]?.name
        }
        // No removed-machine context on this client (the web's
        // removedContextStore): a tombstoned machine's sessions rank by
        // title and cliType only and carry no "removed" tag.
        return SessionCandidate(session = session, projectLabel = projectLabel, machineName = machineName)
    }
}
