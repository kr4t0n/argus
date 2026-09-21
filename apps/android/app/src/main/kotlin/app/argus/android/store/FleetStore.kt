package app.argus.android.store

import app.argus.core.engine.ProjectGroups
import app.argus.core.engine.ProjectRef
import app.argus.core.model.MachineDTO
import app.argus.core.model.MachineStatus
import app.argus.core.model.ProjectDTO
import app.argus.core.model.SessionDTO
import app.argus.core.realtime.IdStatusPayload
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Machines / projects — the fleet the session list derives its grouping
 * from (port of FleetStore in apps/ios/Argus/Sources/Stores.swift).
 * Sessions route by `projectId → machine + cliType`; nothing keys on
 * agents. Main-thread only.
 */
class FleetStore {
    private val _machines = MutableStateFlow<Map<String, MachineDTO>>(emptyMap())
    val machines: StateFlow<Map<String, MachineDTO>> = _machines.asStateFlow()

    /** Keyed `machineId::workingDir`, mirrors the web's project key. */
    private val _projects = MutableStateFlow<Map<String, ProjectDTO>>(emptyMap())
    val projects: StateFlow<Map<String, ProjectDTO>> = _projects.asStateFlow()

    fun reset() {
        _machines.value = emptyMap()
        _projects.value = emptyMap()
    }

    fun setMachines(list: List<MachineDTO>) {
        _machines.value = list.associateBy { it.id }
    }

    fun setProjects(list: List<ProjectDTO>) {
        _projects.value = list.associateBy { ProjectGroups.projectKey(it.machineId, it.workingDir) }
    }

    fun upsert(machine: MachineDTO) {
        _machines.value = _machines.value + (machine.id to machine)
    }

    fun removeMachine(id: String) {
        _machines.value = _machines.value - id
    }

    fun applyMachineStatus(payload: IdStatusPayload) {
        val machine = _machines.value[payload.id] ?: return
        val status = MachineStatus.entries.firstOrNull { it.wire == payload.status } ?: MachineStatus.UNKNOWN
        upsert(machine.copy(status = status))
    }

    fun upsert(project: ProjectDTO) {
        _projects.value = _projects.value +
            (ProjectGroups.projectKey(project.machineId, project.workingDir) to project)
    }

    /**
     * Resolve a session's [ProjectRef]: `session.projectId` is
     * authoritative, the `(machineId, workingDir)` pair is recovered from
     * the hydrated Project rows. Null for workdir-less sessions and during
     * the boot race before the store has the row.
     */
    fun projectRef(session: SessionDTO?): ProjectRef? =
        ProjectGroups.resolveProjectRef(session, _projects.value.values)
}
