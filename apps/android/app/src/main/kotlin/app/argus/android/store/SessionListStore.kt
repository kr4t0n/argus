package app.argus.android.store

import app.argus.core.engine.ProjectGroup
import app.argus.core.engine.ProjectGroups
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
}
