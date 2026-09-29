@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package app.argus.android.ui.sessions

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.argus.android.AppModel
import app.argus.android.PaletteMode
import app.argus.android.Route
import app.argus.android.ui.create.NewProjectSheet
import app.argus.android.ui.create.NewSessionSheet
import app.argus.android.ui.components.AgentTypeGlyph
import app.argus.android.ui.components.ArgusGlyphs
import app.argus.android.ui.components.ConnectionBanner
import app.argus.android.ui.components.SessionStatusDot
import app.argus.android.ui.components.StatusCircle
import app.argus.android.ui.theme.argusPalette
import app.argus.core.engine.ProjectGroup
import app.argus.core.engine.ProjectGroups
import app.argus.core.engine.RelativeTime
import app.argus.core.model.MachineDTO
import app.argus.core.model.MachineStatus
import app.argus.core.model.SessionDTO
import kotlinx.coroutines.launch

/**
 * Sessions grouped by project (the `(machineId, workingDir)` pair), a
 * machines section, and the account row — the phone form of the iOS
 * sidebar (SessionListView.swift). Collapse and per-project archive
 * reveal are in-memory for now (iOS persists them; Phase 3 polish).
 *
 * The three sections render as inset "islands" — the grouped-list look
 * of the iOS sidebar: one rounded card for every project (headers,
 * sessions and the archived-projects row are flat rows inside it, NOT a
 * card per project, so a collapsed project is just a compact row), a
 * "Machines" title over the machines card, and the account card. The
 * list stays lazy: each row is its own `LazyColumn` item and rounds
 * only the corners it owns (first row the top pair, last row the
 * bottom pair), which is why the projects section is flattened into
 * [ProjectsRow]s first — a row's corners depend on where it sits after
 * collapse and archive-reveal are applied.
 */
@Composable
fun SessionListScreen(app: AppModel, onOpenSession: (String) -> Unit) {
    // Creation sheets — project-first, exactly the web's creation
    // hierarchy: a project row's "+" makes a session inside it, a
    // machine's "New project…" makes a working dir + first session.
    var newSessionIn by remember { mutableStateOf<ProjectGroup?>(null) }
    var newProjectOn by remember { mutableStateOf<MachineDTO?>(null) }
    val sessions by app.sessionList.sessions.collectAsState()
    val loaded by app.sessionList.loaded.collectAsState()
    val machines by app.fleet.machines.collectAsState()
    val projects by app.fleet.projects.collectAsState()
    val user by app.user.collectAsState()
    val scope = rememberCoroutineScope()

    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    val showArchived = remember { mutableStateMapOf<String, Boolean>() }
    var showArchivedProjects by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<SessionDTO?>(null) }

    val allGroups = remember(sessions, projects, machines) {
        ProjectGroups.group(sessions.values, projects, machines)
    }
    val archivedProjectCount = allGroups.count { it.archived }
    val groups = if (showArchivedProjects) allGroups else allGroups.filter { !it.archived }
    val machineRows = remember(machines) { ProjectGroups.sortMachines(machines.values) }
    // Reads of the collapse / reveal maps here subscribe the screen to
    // them, so toggling a project rebuilds the rows (and their corners).
    val projectRows = buildList<ProjectsRow> {
        if (groups.isEmpty()) add(ProjectsRow.Empty)
        for (group in groups) {
            add(ProjectsRow.Header(group))
            if (collapsed[group.id] != true) {
                for (session in group.sessions) add(ProjectsRow.Session(session, archived = false))
                if (showArchived[group.id] == true) {
                    for (session in group.archivedSessions) add(ProjectsRow.Session(session, archived = true))
                }
            }
        }
        if (archivedProjectCount > 0) add(ProjectsRow.ArchivedToggle)
    }
    val islandColor = islandColor()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Argus") },
                actions = {
                    // The one on-screen way into the palette: a phone
                    // has no Ctrl chords, and the web breaks the same
                    // circle with its sidebar keyboard glyph.
                    IconButton(onClick = { app.openPalette(PaletteMode.SESSION) }) {
                        Icon(Icons.Default.Search, contentDescription = "Search sessions")
                    }
                    IconButton(onClick = { scope.launch { app.refreshAll() } }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Keyboard shortcuts") },
                                onClick = {
                                    menuOpen = false
                                    app.openPalette(PaletteMode.HELP)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("Account") },
                                onClick = {
                                    menuOpen = false
                                    app.navigate(Route.User)
                                },
                            )
                        }
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(Modifier.padding(innerPadding).fillMaxSize()) {
            ConnectionBanner(app)
            if (!loaded) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                return@Column
            }
            LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 12.dp, bottom = 24.dp)) {
                itemsIndexed(projectRows, key = { _, row -> row.key }) { index, row ->
                    val island = Modifier.island(islandColor, first = index == 0, last = index == projectRows.lastIndex)
                    when (row) {
                        ProjectsRow.Empty -> Text(
                            "No sessions yet — create one from a machine's \"New project…\".",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = island.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                        )
                        is ProjectsRow.Header -> {
                            val group = row.group
                            ProjectHeader(
                                group = group,
                                collapsed = collapsed[group.id] == true,
                                showingArchived = showArchived[group.id] == true,
                                onToggleCollapsed = { collapsed[group.id] = collapsed[group.id] != true },
                                onToggleArchived = { showArchived[group.id] = showArchived[group.id] != true },
                                // The synthetic "no project" bucket has no
                                // path to anchor a session against.
                                onNewSession = if (group.machineId != null && group.workingDir != null) {
                                    { newSessionIn = group }
                                } else {
                                    null
                                },
                                modifier = island,
                            )
                        }
                        is ProjectsRow.Session -> {
                            val session = row.session
                            SessionRow(
                                session = session,
                                archived = row.archived,
                                onOpen = { onOpenSession(session.id) },
                                onRename = { renameTarget = session },
                                onArchive = { scope.launch { archive(app, session, archive = !row.archived) } },
                                modifier = island,
                            )
                        }
                        ProjectsRow.ArchivedToggle -> ArchivedProjectsToggle(
                            count = archivedProjectCount,
                            showing = showArchivedProjects,
                            onToggle = { showArchivedProjects = !showArchivedProjects },
                            modifier = island,
                        )
                    }
                }

                item(key = "machines-header") { IslandTitle("Machines") }
                if (machineRows.isEmpty()) {
                    item(key = "machines-empty") {
                        Text(
                            "No machines yet — install a sidecar to add one.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.island(islandColor, first = true, last = true)
                                .fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                        )
                    }
                }
                itemsIndexed(machineRows, key = { _, machine -> "m:${machine.id}" }) { index, machine ->
                    MachineRow(
                        machine = machine,
                        onOpen = { app.navigate(Route.Machine(machine.id)) },
                        onNewProject = { newProjectOn = machine },
                        modifier = Modifier.island(islandColor, first = index == 0, last = index == machineRows.lastIndex),
                    )
                }

                item(key = "account") {
                    Spacer(Modifier.height(16.dp))
                    Row(
                        modifier = Modifier
                            .island(islandColor, first = true, last = true)
                            .fillMaxWidth()
                            .combinedClickable(onClick = { app.navigate(Route.User) })
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Default.AccountCircle,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(22.dp),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(user?.email ?: "Account", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(user?.role ?: "", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }

    newSessionIn?.let { group ->
        NewSessionSheet(app = app, project = group, onDismiss = { newSessionIn = null })
    }
    newProjectOn?.let { machine ->
        NewProjectSheet(app = app, machine = machine, onDismiss = { newProjectOn = null })
    }
    renameTarget?.let { target ->
        RenameDialog(
            initial = target.title,
            onDismiss = { renameTarget = null },
            onRename = { title ->
                renameTarget = null
                scope.launch {
                    try {
                        app.client?.renameSession(target.id, title)?.let { app.sessionList.upsert(it) }
                    } catch (e: Exception) {
                        app.handleApiError(e)
                    }
                }
            },
        )
    }
}

private suspend fun archive(app: AppModel, session: SessionDTO, archive: Boolean) {
    val client = app.client ?: return
    try {
        val updated = if (archive) client.archiveSession(session.id) else client.unarchiveSession(session.id)
        app.sessionList.upsert(updated)
    } catch (e: Exception) {
        app.handleApiError(e)
    }
}

/**
 * The projects island, flattened: one entry per rendered row so the
 * first and last can round their corners. Keys match the previous
 * per-item keys, so item identity (and any scroll anchoring) survives.
 */
private sealed interface ProjectsRow {
    val key: String

    data class Header(val group: ProjectGroup) : ProjectsRow {
        override val key get() = "group:${group.id}"
    }

    data class Session(val session: SessionDTO, val archived: Boolean) : ProjectsRow {
        override val key get() = "s:${session.id}"
    }

    data object ArchivedToggle : ProjectsRow {
        override val key get() = "archived-projects-toggle"
    }

    data object Empty : ProjectsRow {
        override val key get() = "empty"
    }
}

private val IslandRadius = 12.dp

/**
 * The card surface: one step above the page on both themes — white on
 * the F8F8F8 page in light (iOS's white cells on the grouped grey), the
 * surface1 grey on the near-black page in dark.
 */
@Composable
private fun islandColor(): Color =
    if (argusPalette.isDark) MaterialTheme.colorScheme.surfaceContainerLow
    else MaterialTheme.colorScheme.surfaceContainerLowest

/**
 * Inset a row into its section's island. Rows are independent lazy
 * items with no spacing, so a run of them reads as one card as long as
 * only the first rounds the top corners and only the last the bottom
 * ones. The clip comes before the row's own clickable, so the ripple
 * stays inside the rounded corners.
 */
private fun Modifier.island(color: Color, first: Boolean, last: Boolean): Modifier {
    val top = if (first) IslandRadius else 0.dp
    val bottom = if (last) IslandRadius else 0.dp
    return padding(horizontal = 16.dp)
        .clip(RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom))
        .background(color)
}

/** Section title in the gap above an island — iOS's `Section("Machines")` header. */
@Composable
private fun IslandTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 30.dp, end = 16.dp, top = 20.dp, bottom = 6.dp),
    )
}

/**
 * The "N archived projects" / "Hide archived projects" row closing the
 * projects island — iOS `archivedProjectsToggle`: archive-box + label,
 * neutral while hidden, emerald while revealed (the per-project eye's
 * language).
 */
@Composable
private fun ArchivedProjectsToggle(count: Int, showing: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val tint = if (showing) argusPalette.statusDone else MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onToggle)
            .padding(start = 14.dp, end = 16.dp, top = 10.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(ArgusGlyphs.Archive, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
        Spacer(Modifier.width(7.dp))
        Text(
            if (showing) "Hide archived projects" else "$count archived project${if (count == 1) "" else "s"}",
            style = MaterialTheme.typography.labelMedium,
            color = tint,
        )
    }
}

/**
 * The project row — iOS `ProjectRowHeader` / web `ProjectRow`: chevron ·
 * folder · title · count, then the per-project eye (only when there is
 * an archive to reveal; emerald open eye when showing, neutral slashed
 * eye when hidden) and the `+`. The leading group takes the slack with a
 * weight of its own so the trailing icons sit on the right edge whatever
 * the title's width — a `weight(fill = false)` on the title itself left
 * its unused share as dead space and pushed the icons inward.
 */
@Composable
private fun ProjectHeader(
    group: ProjectGroup,
    collapsed: Boolean,
    showingArchived: Boolean,
    onToggleCollapsed: () -> Unit,
    onToggleArchived: () -> Unit,
    onNewSession: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier = modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onToggleCollapsed)
            .padding(start = 10.dp, end = 6.dp, top = 8.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (collapsed) Icons.Default.KeyboardArrowRight else Icons.Default.KeyboardArrowDown,
                contentDescription = null,
                tint = secondary.copy(alpha = 0.7f),
                modifier = Modifier.size(16.dp),
            )
            Spacer(Modifier.width(4.dp))
            Icon(
                ArgusGlyphs.Folder,
                contentDescription = null,
                tint = secondary,
                modifier = Modifier.size(15.dp),
            )
            Spacer(Modifier.width(7.dp))
            Text(
                group.title,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = secondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                "${group.sessions.count()}",
                style = MaterialTheme.typography.labelSmall,
                color = secondary.copy(alpha = 0.7f),
            )
        }
        if (group.archivedSessions.isNotEmpty()) {
            IconButton(onClick = onToggleArchived, modifier = Modifier.size(28.dp)) {
                Icon(
                    if (showingArchived) ArgusGlyphs.Eye else ArgusGlyphs.EyeOff,
                    contentDescription = if (showingArchived) "Hide archived sessions" else "Show ${group.archivedSessions.size} archived sessions",
                    tint = if (showingArchived) argusPalette.statusDone else secondary,
                    modifier = Modifier.size(15.dp),
                )
            }
        }
        if (onNewSession != null) {
            IconButton(onClick = onNewSession, modifier = Modifier.size(28.dp)) {
                Icon(
                    Icons.Default.Add,
                    contentDescription = "New session",
                    tint = secondary,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

/**
 * Single compact line — glyph · title · dot · time (web parity). Archived
 * rows render dimmed with an archive-box in the dot slot (iOS parity —
 * there is no live status to show). Long-press for rename / archive.
 */
@Composable
private fun SessionRow(
    session: SessionDTO,
    archived: Boolean,
    onOpen: () -> Unit,
    onRename: () -> Unit,
    onArchive: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val dim = if (archived) 0.55f else 1f
    Box(modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onOpen, onLongClick = { menuOpen = true })
                .padding(start = 30.dp, end = 16.dp, top = 9.dp, bottom = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AgentTypeGlyph(session.cliType ?: "custom", size = 16)
            Spacer(Modifier.width(10.dp))
            Text(
                session.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (!archived && session.unread) FontWeight.SemiBold else FontWeight.Normal,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = dim),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(6.dp))
            if (archived) {
                Icon(
                    ArgusGlyphs.Archive,
                    contentDescription = "Archived",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                    modifier = Modifier.size(10.dp),
                )
            } else {
                SessionStatusDot(session)
            }
            Spacer(Modifier.width(8.dp))
            Text(
                RelativeTime.short(session.updatedAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(text = { Text("Rename") }, onClick = { menuOpen = false; onRename() })
            DropdownMenuItem(
                text = { Text(if (archived) "Unarchive" else "Archive") },
                onClick = { menuOpen = false; onArchive() },
            )
        }
    }
}

/**
 * Machine row — iOS `MachineRow`: monitor glyph (emerald while online,
 * neutral otherwise) · name · trailing status dot. The installed
 * adapters are the machine panel's business, not the row's. Tap opens
 * the machine panel; long-press offers the machine's creation action.
 */
@Composable
private fun MachineRow(machine: MachineDTO, onOpen: () -> Unit, onNewProject: () -> Unit, modifier: Modifier = Modifier) {
    val online = machine.status == MachineStatus.ONLINE
    val liveTint = if (online) argusPalette.statusDone else MaterialTheme.colorScheme.onSurfaceVariant
    var menuOpen by remember { mutableStateOf(false) }
    Box(modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onOpen, onLongClick = { menuOpen = true })
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                ArgusGlyphs.Monitor,
                contentDescription = null,
                tint = liveTint,
                modifier = Modifier.size(15.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(machine.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Spacer(Modifier.width(6.dp))
            StatusCircle(
                color = if (online) argusPalette.statusDone else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
                modifier = Modifier.size(6.dp),
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(text = { Text("New project…") }, onClick = { menuOpen = false; onNewProject() })
        }
    }
}

@Composable
fun RenameDialog(initial: String, onDismiss: () -> Unit, onRename: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename session") },
        text = {
            OutlinedTextField(value = text, onValueChange = { text = it }, singleLine = true, label = { Text("Title") })
        },
        confirmButton = {
            TextButton(
                onClick = { if (text.trim().isNotEmpty() && text.trim() != initial) onRename(text.trim()) else onDismiss() },
            ) { Text("Rename") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
