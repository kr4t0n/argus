package app.argus.core.engine

import app.argus.core.model.MachineDTO
import app.argus.core.model.MachineStatus
import app.argus.core.model.ProjectDTO
import app.argus.core.testSession
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProjectGroupsTest {
    private fun machine(id: String, name: String, status: MachineStatus = MachineStatus.ONLINE) = MachineDTO(
        id = id, name = name, hostname = name, os = "linux", arch = "arm64", sidecarVersion = "0.3.0",
        status = status, lastSeenAt = "2026-07-05T10:00:00.000Z", registeredAt = "2026-07-05T10:00:00.000Z",
    )

    private fun project(id: String, machineId: String, workingDir: String, name: String? = null, archivedAt: String? = null) =
        ProjectDTO(id = id, machineId = machineId, workingDir = workingDir, name = name, archivedAt = archivedAt)

    private fun keyed(vararg projects: ProjectDTO): Map<String, ProjectDTO> =
        projects.associateBy { ProjectGroups.projectKey(it.machineId, it.workingDir) }

    @Test
    fun `basename mirrors lastPathComponent`() {
        assertEquals("argus", ProjectGroups.basename("/home/kyle/argus"))
        assertEquals("argus", ProjectGroups.basename("/home/kyle/argus/"))
        assertEquals("/", ProjectGroups.basename("/"))
        assertEquals("", ProjectGroups.basename(""))
    }

    @Test
    fun `sessions group by their project row, newest first, archived split out`() {
        val machines = mapOf("m1" to machine("m1", "alpha"))
        val projects = keyed(project("p1", "m1", "/w/argus"))
        val groups = ProjectGroups.group(
            listOf(
                testSession(id = "s-old", projectId = "p1", updatedAt = "2026-07-01T00:00:00.000Z"),
                testSession(id = "s-new", projectId = "p1", updatedAt = "2026-07-05T00:00:00.000Z"),
                testSession(id = "s-arch", projectId = "p1", archivedAt = "2026-07-02T00:00:00.000Z"),
            ),
            projects, machines,
        )
        assertEquals(1, groups.size)
        val group = groups[0]
        assertEquals("m1::/w/argus", group.id)
        assertEquals("argus", group.title)
        assertEquals("alpha", group.machineName)
        assertEquals(listOf("s-new", "s-old"), group.sessions.map { it.id })
        assertEquals(listOf("s-arch"), group.archivedSessions.map { it.id })
    }

    @Test
    fun `a picked project name overlays the basename, and an archived row marks the group`() {
        val projects = keyed(project("p1", "m1", "/w/argus", name = "My Project", archivedAt = "2026-07-05T00:00:00.000Z"))
        val groups = ProjectGroups.group(listOf(testSession(projectId = "p1")), projects, mapOf("m1" to machine("m1", "alpha")))
        assertEquals("My Project", groups[0].title)
        assertTrue(groups[0].archived)
    }

    @Test
    fun `ordering - online machines, then machine name, then title, no-project bucket sinks, orphans last`() {
        val machines = mapOf(
            "off" to machine("off", "aardvark", MachineStatus.OFFLINE),
            "b" to machine("b", "Bravo"),
            "a" to machine("a", "alpha"),
        )
        val projects = keyed(
            project("p-off", "off", "/w/first"),
            project("p-b", "b", "/w/zeta"),
            project("p-a2", "a", "/w/Beta"),
            project("p-a1", "a", "/w/alpha"),
            project("p-a-none", "a", ""),
        )
        val groups = ProjectGroups.group(
            listOf(
                testSession(id = "1", projectId = "p-off"),
                testSession(id = "2", projectId = "p-b"),
                testSession(id = "3", projectId = "p-a2"),
                testSession(id = "4", projectId = "p-a1"),
                testSession(id = "5", projectId = "p-a-none"),
                testSession(id = "6", projectId = null),
                testSession(id = "7", projectId = "p-missing"),
            ),
            projects, machines,
        )
        assertEquals(
            listOf("a::/w/alpha", "a::/w/Beta", "a::", "b::/w/zeta", "off::/w/first", ProjectGroups.ORPHAN_KEY),
            groups.map { it.id },
        )
        val orphan = groups.last()
        assertNull(orphan.machineId)
        assertEquals(setOf("6", "7"), orphan.sessions.map { it.id }.toSet())
        assertEquals(ProjectGroups.NO_PROJECT_TITLE, groups[2].title)
        assertNull(groups[2].workingDir)
    }

    @Test
    fun `projectRef resolves through the session's pinned project id`() {
        val projects = listOf(project("p1", "m1", "/w/argus"))
        val ref = ProjectGroups.resolveProjectRef(testSession(projectId = "p1"), projects)
        assertEquals(ProjectRef("p1", "m1", "/w/argus"), ref)
        assertNull(ProjectGroups.resolveProjectRef(testSession(projectId = null), projects))
        assertNull(ProjectGroups.resolveProjectRef(testSession(projectId = "nope"), projects))
        assertNull(ProjectGroups.resolveProjectRef(null, projects))
    }

    @Test
    fun `machines sort offline last then by name, archived hidden`() {
        val sorted = ProjectGroups.sortMachines(
            listOf(
                machine("1", "zulu"),
                machine("2", "Alpha", MachineStatus.OFFLINE),
                machine("3", "bravo"),
                machine("4", "gone").copy(archivedAt = "2026-07-05T00:00:00.000Z"),
            ),
        )
        assertEquals(listOf("bravo", "zulu", "Alpha"), sorted.map { it.name })
    }
}
