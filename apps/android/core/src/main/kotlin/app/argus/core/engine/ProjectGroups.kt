package app.argus.core.engine

import app.argus.core.model.MachineDTO
import app.argus.core.model.MachineStatus
import app.argus.core.model.ProjectDTO
import app.argus.core.model.SessionDTO
import java.text.Collator
import java.util.Locale

// Port of the sidebar grouping in apps/ios/Argus/Sources/Stores.swift
// (`SessionListStore.projectGroups`, `FleetStore.projectRef`) — whose
// ordering the web then ported back as `sortProjectGroups` in
// apps/web/src/lib/projects.ts. Keep all three in lockstep: the same
// fleet must list in the same order on every client.
//
// Pure functions over the stores' maps, so the ordering rules are unit
// tested without any UI.

/**
 * Everything the project-addressed read paths need: `projectId` drives
 * the REST routes, the `(machineId, workingDir)` pair names the WS room
 * and the machine for reachability. Resolved via [ProjectGroups.resolveProjectRef].
 */
data class ProjectRef(
    val projectId: String,
    val machineId: String,
    val workingDir: String,
)

/**
 * One sidebar group: the `(machineId, workingDir)` pair every session in
 * that directory shares.
 */
data class ProjectGroup(
    val id: String,
    /** The user-picked Project.name, else the workingDir's basename, or "no project". */
    val title: String,
    /**
     * Null ONLY for the orphan bucket (can't anchor creation there);
     * groups resolved via a Project row always carry it.
     */
    val machineId: String?,
    /** Null for the per-machine "no project" bucket and the orphan bucket. */
    val workingDir: String?,
    val machineName: String,
    /**
     * True when the backing Project row is archived. The list hides these
     * behind the global "show archived projects" toggle. Always false for
     * the orphan bucket (no Project row to archive).
     */
    val archived: Boolean,
    /** Active (non-archived) sessions, newest-first. */
    val sessions: List<SessionDTO>,
    /**
     * Archived sessions, newest-first — rendered only when the project's
     * eye toggle is on, but always carried so the header can offer the
     * toggle. A project whose sessions are ALL archived still gets its
     * header row; otherwise the archive would be unreachable.
     */
    val archivedSessions: List<SessionDTO>,
)

object ProjectGroups {
    /** Key of the trailing bucket for sessions with no resolvable project. */
    const val ORPHAN_KEY = "__orphan__"
    const val NO_PROJECT_TITLE = "no project"

    /** The web's project key — `machineId::workingDir`. */
    fun projectKey(machineId: String, workingDir: String): String = "$machineId::$workingDir"

    /** Last path component, like Foundation's `lastPathComponent` / the web's `basename`. */
    fun basename(path: String): String {
        val trimmed = path.trimEnd('/')
        if (trimmed.isEmpty()) return if (path.startsWith("/")) "/" else ""
        return trimmed.substringAfterLast('/')
    }

    /**
     * Resolve a session's [ProjectRef]. `session.projectId` is
     * authoritative — pinned at create — and the `(machineId, workingDir)`
     * pair is recovered from the hydrated Project rows by id. Null for
     * workdir-less sessions and during the boot race before the store has
     * the row.
     */
    fun resolveProjectRef(session: SessionDTO?, projects: Collection<ProjectDTO>): ProjectRef? {
        val projectId = session?.projectId ?: return null
        val project = projects.firstOrNull { it.id == projectId } ?: return null
        return ProjectRef(projectId = projectId, machineId = project.machineId, workingDir = project.workingDir)
    }

    /**
     * Group sessions into projects. The grouping key is `session.projectId`
     * resolved through the server's Project rows; sessions whose row
     * hasn't hydrated yet (boot race) or that carry no projectId land in
     * a trailing [ORPHAN_KEY] bucket so they stay reachable.
     *
     * Ordering rule (deliberate — replaces the old piggyback on the agent
     * sort, which died with per-agent status):
     *   1. groups on ONLINE machines first,
     *   2. then machine name (case-insensitive, accent-sensitive — the
     *      web's `localeCompare(…, { sensitivity: 'accent' })`),
     *   3. then project display name; the per-machine "no project" bucket
     *      sinks below named projects of the same machine,
     *   4. group key as the deterministic tiebreaker.
     * The orphan bucket is always last. Sessions within a project are
     * newest-first.
     *
     * @param projects keyed by [projectKey] (the fleet store's map).
     * @param machines keyed by machine id.
     */
    fun group(
        sessions: Collection<SessionDTO>,
        projects: Map<String, ProjectDTO>,
        machines: Map<String, MachineDTO>,
    ): List<ProjectGroup> {
        val projectsById = projects.values.associateBy { it.id }
        val builders = LinkedHashMap<String, GroupBuilder>()
        val orphans = ArrayList<SessionDTO>()

        for (session in sessions) {
            val project = session.projectId?.let { projectsById[it] }
            if (project == null) {
                orphans += session
                continue
            }
            val wd = project.workingDir
            val key = projectKey(project.machineId, wd)
            val builder = builders.getOrPut(key) {
                // The pair-keyed row (when hydrated) overlays the user-picked
                // name regardless of which path anchored us.
                val row = projects[key]
                val fallbackTitle = if (wd.isEmpty()) NO_PROJECT_TITLE else basename(wd)
                val name = row?.name?.takeIf { it.isNotEmpty() }
                GroupBuilder(
                    id = key,
                    title = name ?: fallbackTitle,
                    machineId = project.machineId,
                    workingDir = wd.ifEmpty { null },
                    machineName = machines[project.machineId]?.name ?: "",
                    archived = row?.archivedAt != null,
                )
            }
            if (session.archivedAt == null) builder.live += session else builder.archivedList += session
        }

        val result = ArrayList<ProjectGroup>(builders.size + 1)
        for (b in builders.values) {
            result += ProjectGroup(
                id = b.id,
                title = b.title,
                machineId = b.machineId,
                workingDir = b.workingDir,
                machineName = b.machineName,
                archived = b.archived,
                sessions = b.live.sortedByDescending { it.updatedAt },
                archivedSessions = b.archivedList.sortedByDescending { it.updatedAt },
            )
        }
        if (orphans.isNotEmpty()) {
            result += ProjectGroup(
                id = ORPHAN_KEY,
                title = NO_PROJECT_TITLE,
                machineId = null,
                workingDir = null,
                machineName = "",
                archived = false,
                sessions = orphans.filter { it.archivedAt == null }.sortedByDescending { it.updatedAt },
                archivedSessions = orphans.filter { it.archivedAt != null }.sortedByDescending { it.updatedAt },
            )
        }
        return result.sortedWith(comparator(machines))
    }

    /** The ordering rule above, as a comparator (stable under `sortedWith`). */
    fun comparator(machines: Map<String, MachineDTO>): Comparator<ProjectGroup> = Comparator { a, b ->
        val aOrphan = a.machineId == null
        val bOrphan = b.machineId == null
        if (aOrphan != bOrphan) return@Comparator if (aOrphan) 1 else -1
        val aOnline = if (a.machineId?.let { machines[it]?.status } == MachineStatus.ONLINE) 0 else 1
        val bOnline = if (b.machineId?.let { machines[it]?.status } == MachineStatus.ONLINE) 0 else 1
        if (aOnline != bOnline) return@Comparator aOnline - bOnline
        val byMachine = caseInsensitive.compare(a.machineName, b.machineName)
        if (byMachine != 0) return@Comparator byMachine
        val aNoProject = a.workingDir == null
        val bNoProject = b.workingDir == null
        if (aNoProject != bNoProject) return@Comparator if (aNoProject) 1 else -1
        val byTitle = caseInsensitive.compare(a.title, b.title)
        if (byTitle != 0) return@Comparator byTitle
        a.id.compareTo(b.id)
    }

    /**
     * Machine rows for the sidebar's Machines section — web parity
     * (`machineStore.sortOrder`): archived hidden, offline sinks, then name.
     */
    fun sortMachines(machines: Collection<MachineDTO>): List<MachineDTO> =
        machines
            .filter { it.archivedAt == null }
            .sortedWith(
                compareBy<MachineDTO> { if (it.status == MachineStatus.OFFLINE) 1 else 0 }
                    .thenComparator { a, b -> caseInsensitive.compare(a.name, b.name) },
            )

    /**
     * Case-insensitive but accent-sensitive, matching iOS's
     * `localizedCaseInsensitiveCompare` and the web's `localeCompare`
     * with `sensitivity: 'accent'`. A Collator is not thread-safe; this
     * one is only ever driven from the UI thread and tests.
     */
    private val caseInsensitive: Collator = Collator.getInstance(Locale.ROOT).apply {
        strength = Collator.SECONDARY
    }

    private class GroupBuilder(
        val id: String,
        val title: String,
        val machineId: String,
        val workingDir: String?,
        val machineName: String,
        val archived: Boolean,
    ) {
        val live = ArrayList<SessionDTO>()
        val archivedList = ArrayList<SessionDTO>()
    }
}
