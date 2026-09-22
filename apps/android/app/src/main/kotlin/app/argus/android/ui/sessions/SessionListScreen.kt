@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package app.argus.android.ui.sessions

import androidx.compose.foundation.ExperimentalFoundationApi
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
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
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
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.argus.android.AppModel
import app.argus.android.PaletteMode
import app.argus.android.Route
import app.argus.android.ui.create.NewProjectSheet
import app.argus.android.ui.create.NewSessionSheet
import app.argus.android.ui.components.AgentTypeGlyph
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
            LazyColumn(modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                if (groups.isEmpty()) {
                    item {
                        Text(
                            "No sessions yet — create one from the dashboard.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                }
                for (group in groups) {
                    item(key = "group:${group.id}") {
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
                        )
                    }
                    if (collapsed[group.id] != true) {
                        items(group.sessions, key = { "s:${it.id}" }) { session ->
                            SessionRow(session, archived = false, onOpen = { onOpenSession(session.id) },
                                onRename = { renameTarget = session },
                                onArchive = { scope.launch { archive(app, session, archive = true) } })
                        }
                        if (showArchived[group.id] == true) {
                            items(group.archivedSessions, key = { "s:${it.id}" }) { session ->
                                SessionRow(session, archived = true, onOpen = { onOpenSession(session.id) },
                                    onRename = { renameTarget = session },
                                    onArchive = { scope.launch { archive(app, session, archive = false) } })
                            }
                        }
                    }
                }
                if (archivedProjectCount > 0) {
                    item(key = "archived-projects-toggle") {
                        TextButton(onClick = { showArchivedProjects = !showArchivedProjects }, modifier = Modifier.padding(horizontal = 4.dp)) {
                            Text(
                                if (showArchivedProjects) "Hide archived projects"
                                else "$archivedProjectCount archived project${if (archivedProjectCount == 1) "" else "s"}",
                                style = MaterialTheme.typography.labelMedium,
                                color = if (showArchivedProjects) argusPalette.statusDone else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                item(key = "machines-header") {
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Text(
                        "MACHINES",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
                items(machineRows, key = { "m:${it.id}" }) { machine ->
                    MachineRow(
                        machine = machine,
                        onOpen = { app.navigate(Route.Machine(machine.id)) },
                        onNewProject = { newProjectOn = machine },
                    )
                }

                item(key = "account") {
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .combinedClickable(onClick = { app.navigate(Route.User) })
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
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

@Composable
private fun ProjectHeader(
    group: ProjectGroup,
    collapsed: Boolean,
    showingArchived: Boolean,
    onToggleCollapsed: () -> Unit,
    onToggleArchived: () -> Unit,
    onNewSession: (() -> Unit)?,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onToggleCollapsed)
            .padding(start = 8.dp, end = 8.dp, top = 10.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (collapsed) Icons.Default.KeyboardArrowRight else Icons.Default.KeyboardArrowDown,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            group.title,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            "${group.sessions.count()}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (group.machineName.isNotEmpty()) {
            Spacer(Modifier.width(8.dp))
            Text(
                group.machineName,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.weight(1f))
        // The web's per-project eye: only offered when there is an
        // archive to reveal — emerald when showing, neutral when hidden.
        if (group.archivedSessions.isNotEmpty()) {
            TextButton(onClick = onToggleArchived) {
                Text(
                    if (showingArchived) "hide archived" else "${group.archivedSessions.size} archived",
                    style = MaterialTheme.typography.labelSmall,
                    color = if (showingArchived) argusPalette.statusDone else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (onNewSession != null) {
            IconButton(onClick = onNewSession, modifier = Modifier.size(28.dp)) {
                Icon(
                    Icons.Default.Add,
                    contentDescription = "New session",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

/**
 * Single compact line — glyph · title · dot · time (web parity). Archived
 * rows render dimmed. Long-press for rename / archive.
 */
@Composable
private fun SessionRow(
    session: SessionDTO,
    archived: Boolean,
    onOpen: () -> Unit,
    onRename: () -> Unit,
    onArchive: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val dim = if (archived) 0.55f else 1f
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onOpen, onLongClick = { menuOpen = true })
                .padding(start = 28.dp, end = 16.dp, top = 9.dp, bottom = 9.dp),
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
            if (!archived) SessionStatusDot(session)
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

/** Tap opens the machine panel; long-press offers the machine's creation action. */
@Composable
private fun MachineRow(machine: MachineDTO, onOpen: () -> Unit, onNewProject: () -> Unit) {
    val online = machine.status == MachineStatus.ONLINE
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(onClick = onOpen, onLongClick = { menuOpen = true })
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
        StatusCircle(
            color = if (online) argusPalette.statusDone else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f),
            modifier = Modifier.size(8.dp),
        )
        Spacer(Modifier.width(10.dp))
        Text(machine.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(
            machine.availableAdapters.joinToString(" · ") { it.type },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
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
