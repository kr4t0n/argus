@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.machine

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.AppModel
import app.argus.android.Route
import app.argus.android.ui.components.AgentTypeGlyph
import app.argus.android.ui.components.ConnectionBanner
import app.argus.android.ui.components.StatusCircle
import app.argus.android.ui.create.NewProjectSheet
import app.argus.android.ui.files.CenteredUnavailable
import app.argus.android.ui.session.captionStyle
import app.argus.android.ui.session.monoStyle
import app.argus.android.ui.session.secondaryTextColor
import app.argus.android.ui.session.tertiaryTextColor
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.engine.RelativeTime
import app.argus.core.model.MachineDTO
import app.argus.core.model.MachineStatus
import app.argus.core.model.ProjectDTO
import app.argus.core.model.SessionDTO
import app.argus.core.model.SidecarVersionInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Machine detail — the Android counterpart of the web's MachinePanel and
 * a port of apps/ios/Argus/Sources/Views/MachineView.swift: host
 * metadata, discovered adapters, the machine's projects (the unit of
 * work is the project, not the agent — the Agent entity is retired),
 * sidecar version + remote update, and machine delete.
 *
 * Pure projection of the stores: the machine row comes from
 * [AppModel.fleet] and re-renders on every `machine:upsert` /
 * `machine:status` event, so a remote update's completion (the sidecar
 * re-registering with the new version) lands here with no polling.
 *
 * [showBack] is false in the tablet split layout, where the session
 * list column stays on screen and there is nothing to go back to
 * (same contract as SessionScreen).
 */
@Composable
fun MachineScreen(app: AppModel, machineId: String, onBack: () -> Unit, showBack: Boolean = true) {
    val machines by app.fleet.machines.collectAsState()
    val projects by app.fleet.projects.collectAsState()
    val sessions by app.sessionList.sessions.collectAsState()
    val machine: MachineDTO? = machines[machineId]
    val scope = rememberCoroutineScope()

    var versionInfo by remember(machineId) { mutableStateOf<SidecarVersionInfo?>(null) }
    /** Outcome of the last sidecar-update request (accepted, or why it failed). */
    var updateNotice by remember(machineId) { mutableStateOf<String?>(null) }
    /**
     * Why the last remove attempt failed. iOS stays silent here, but a
     * swallowed 4xx on a menu action reads as "the button does nothing".
     */
    var removeError by remember(machineId) { mutableStateOf<String?>(null) }
    var updateBusy by remember(machineId) { mutableStateOf(false) }
    var removeBusy by remember(machineId) { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var showNewProject by remember { mutableStateOf(false) }
    var showRemoveMachine by remember { mutableStateOf(false) }

    /**
     * Non-archived projects on this machine, from the server project
     * store, sorted case-insensitively by display name (the user-picked
     * name, else the working dir — iOS parity; an empty name counts as
     * unset, as the session list treats it).
     */
    val machineProjects: List<ProjectDTO> = remember(projects, machineId) {
        projects.values
            .filter { it.machineId == machineId && it.archivedAt == null }
            .sortedWith(compareBy<ProjectDTO, String>(String.CASE_INSENSITIVE_ORDER) { projectTitle(it) })
    }

    /**
     * Best-effort version badge: a rate-limited GitHub lookup or an
     * offline host must not surface as an error state — the badge just
     * stays blank. A 401 still funnels through [AppModel.handleApiError].
     */
    suspend fun reload() {
        val client = app.client ?: return
        versionInfo = try {
            client.getSidecarVersion(machineId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            app.handleApiError(e)
            null
        }
    }

    // On open, and again whenever the sidecar reports a new version
    // (web parity): after a remote update the machine re-registers via
    // machine:upsert, at which point the cached "update available" is
    // stale and the "→ latest" badge should clear.
    LaunchedEffect(machineId, machine?.sidecarVersion) { reload() }

    fun updateSidecar() {
        val client = app.client ?: return
        if (updateBusy) return
        updateBusy = true
        updateNotice = null
        scope.launch {
            try {
                val accepted = client.updateSidecar(machineId)
                // 202: completion arrives as machine:upsert with the new
                // version once the sidecar re-registers — nothing to poll.
                val from = accepted.fromVersion.ifEmpty { machine?.sidecarVersion ?: "unknown" }
                updateNotice = "Update requested (from $from) — the sidecar restarts itself."
            } catch (e: Exception) {
                app.handleApiError(e)
                updateNotice = (e as? ApiError)?.message ?: e.message ?: "Update failed"
            } finally {
                updateBusy = false
            }
        }
    }

    /**
     * Soft-delete: the server sets a sticky tombstone, the row leaves
     * every dashboard, and NO history is destroyed — sessions stay
     * viewable through the user-scoped list. Terminal by design (no
     * un-delete). Runs on [AppModel.scope], not the screen's scope:
     * clearing the route unmounts this screen, and a
     * `rememberCoroutineScope` would cancel the trailing `refreshAll()`
     * mid-flight.
     */
    fun removeMachine() {
        val client = app.client ?: return
        if (removeBusy) return
        removeBusy = true
        removeError = null
        app.scope.launch {
            try {
                client.deleteMachine(machineId)
                // Local removal avoids a one-frame flash before the
                // machine:removed event drops it from the store.
                app.fleet.removeMachine(machineId)
                if (app.route.value == Route.Machine(machineId)) app.navigate(null)
                app.refreshAll()
            } catch (e: Exception) {
                app.handleApiError(e)
                removeError = (e as? ApiError)?.message ?: e.message ?: "Remove failed"
            } finally {
                removeBusy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(machine?.name ?: "Machine", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (showBack) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = {
                    // The iOS `.refreshable` pull: re-check the version
                    // badge and re-pull the fleet lists (status, projects).
                    IconButton(onClick = { scope.launch { reload(); app.refreshAll() } }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("New project…") },
                                enabled = machine != null,
                                onClick = { menuOpen = false; showNewProject = true },
                            )
                            // Only an online sidecar can act on the
                            // control-stream command; offline it would
                            // just sit on the stream until MAXLEN trims it.
                            DropdownMenuItem(
                                text = { Text("Update sidecar") },
                                enabled = machine?.status == MachineStatus.ONLINE && !updateBusy,
                                onClick = { menuOpen = false; updateSidecar() },
                            )
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text("Remove machine…", color = argusPalette.statusFailed) },
                                enabled = machine != null && !removeBusy,
                                onClick = { menuOpen = false; showRemoveMachine = true },
                            )
                        }
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(Modifier.padding(innerPadding).fillMaxSize()) {
            ConnectionBanner(app)
            if (machine == null) {
                CenteredUnavailable("Machine not found", "Removed from the dashboard, or not loaded yet.")
                return@Column
            }
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(bottom = 24.dp),
            ) {
                HostSection(machine, versionInfo, updateNotice, removeError)
                AdaptersSection(machine)
                ProjectsSection(
                    projects = machineProjects,
                    sessions = sessions,
                    onOpenSession = { app.navigate(Route.Session(it)) },
                )
            }
        }
    }

    if (showNewProject && machine != null) {
        NewProjectSheet(app = app, machine = machine, onDismiss = { showNewProject = false })
    }

    if (showRemoveMachine) {
        AlertDialog(
            onDismissRequest = { showRemoveMachine = false },
            title = { Text("Remove machine?") },
            text = {
                Text(
                    "Remove this machine from the dashboard? Sessions stay in the database; " +
                        "the removal is sticky even if the sidecar keeps running.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { showRemoveMachine = false; removeMachine() },
                    enabled = !removeBusy,
                    colors = ButtonDefaults.textButtonColors(contentColor = argusPalette.statusFailed),
                ) { Text("Remove machine") }
            },
            dismissButton = { TextButton(onClick = { showRemoveMachine = false }) { Text("Cancel") } },
        )
    }
}

// MARK: Sections

/**
 * Status / hostname / OS / sidecar / last seen — the iOS `LabeledContent`
 * rows. The sidecar row grows a green "→ latest" when the server's
 * version check says an update is available; the notice lines
 * underneath carry the last update request's outcome and any remove
 * failure.
 */
@Composable
private fun HostSection(
    machine: MachineDTO,
    versionInfo: SidecarVersionInfo?,
    updateNotice: String?,
    removeError: String?,
) {
    val palette = argusPalette
    val online = machine.status == MachineStatus.ONLINE
    // Only a version check that both flags an update AND names the
    // release earns the arrow (the web's badge gate) — "→ " alone says
    // nothing actionable.
    val latest = versionInfo?.takeIf { it.updateAvailable }?.latest?.takeIf { it.isNotEmpty() }

    SectionHeader("Host", first = true)
    LabeledRow("Status") {
        StatusCircle(
            color = if (online) palette.statusDone else secondaryTextColor.copy(alpha = 0.4f),
            modifier = Modifier.size(8.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            machine.status.wire,
            style = MaterialTheme.typography.bodyMedium,
            color = if (online) palette.statusDone else secondaryTextColor,
        )
    }
    LabeledRow("Hostname", machine.hostname, mono = true)
    LabeledRow("OS / arch", "${machine.os} / ${machine.arch}")
    LabeledRow("Sidecar") {
        Text(machine.sidecarVersion, style = monoStyle(12.sp), color = secondaryTextColor, maxLines = 1)
        if (latest != null) {
            Spacer(Modifier.width(6.dp))
            Text("→ $latest", style = monoStyle(12.sp), color = palette.statusDone, maxLines = 1)
        }
    }
    LabeledRow("Last seen", lastSeenLabel(machine.lastSeenAt))
    if (updateNotice != null) {
        Text(
            updateNotice,
            style = captionStyle(),
            color = secondaryTextColor,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
    }
    if (removeError != null) {
        Text(
            removeError,
            style = captionStyle(),
            color = palette.statusFailed,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
    }
}

/**
 * The adapters discovery found on the sidecar host's PATH — what the
 * new-session picker can offer. A service-managed sidecar with a bare
 * unit `PATH` reports none (see the AGENTS.md gotcha), so the empty
 * state is a real signal, not a loading placeholder.
 */
@Composable
private fun AdaptersSection(machine: MachineDTO) {
    SectionHeader("Supports")
    if (machine.availableAdapters.isEmpty()) {
        EmptyText("No CLI agents discovered on PATH.")
        return
    }
    for (adapter in machine.availableAdapters) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AgentTypeGlyph(adapter.type, size = 18)
            Spacer(Modifier.width(10.dp))
            Text(
                adapter.type,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.width(12.dp))
            Spacer(Modifier.weight(1f))
            // The parsed `--version`, else the bare binary name (iOS parity).
            Text(
                adapter.version.ifEmpty { adapter.binary },
                style = captionStyle(),
                color = secondaryTextColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * The machine's projects. A project has no route of its own, so a row
 * opens its most recently updated non-archived session; a project with
 * none renders dimmed and inert (iOS parity) rather than hidden, so the
 * user can still see it exists.
 */
@Composable
private fun ProjectsSection(
    projects: List<ProjectDTO>,
    sessions: Map<String, SessionDTO>,
    onOpenSession: (String) -> Unit,
) {
    SectionHeader("Projects")
    if (projects.isEmpty()) {
        EmptyText("No projects on this machine yet — create one from the menu.")
        return
    }
    for (project in projects) {
        // ISO-8601 timestamps order lexicographically, the same
        // comparison the session-list store's staleness guard relies on.
        val recent = remember(sessions, project.id) {
            sessions.values
                .filter { it.projectId == project.id && it.archivedAt == null }
                .maxByOrNull { it.updatedAt }
        }
        ProjectRow(project = project, enabled = recent != null) {
            if (recent != null) onOpenSession(recent.id)
        }
    }
}

@Composable
private fun ProjectRow(project: ProjectDTO, enabled: Boolean, onOpen: () -> Unit) {
    val dim = if (enabled) 1f else 0.55f
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onOpen)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FolderGlyph(tint = secondaryTextColor.copy(alpha = dim), modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                projectTitle(project),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = dim),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // Head-truncated: the tail of a path (the project dir) is the
            // part that tells two workdirs apart.
            Text(
                project.workingDir,
                style = monoStyle(11.sp),
                color = tertiaryTextColor,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.StartEllipsis,
            )
        }
    }
}

// MARK: Atoms

/** The user-picked name, else the working dir (iOS `project.name ?? project.workingDir`; empty counts as unset). */
private fun projectTitle(project: ProjectDTO): String =
    project.name?.takeIf { it.isNotEmpty() } ?: project.workingDir

/**
 * "5m ago" / "now" from the terse `RelativeTime.short` (the only form
 * `:core` ports); the iOS row uses the longer `RelativeTime.label`.
 */
private fun lastSeenLabel(iso: String): String {
    val short = RelativeTime.short(iso)
    return when (short) {
        "" -> "—"
        "now" -> short
        else -> "$short ago"
    }
}

/** Uppercase section label in the session list's "MACHINES" style, divider-separated after the first. */
@Composable
private fun SectionHeader(title: String, first: Boolean = false) {
    if (!first) HorizontalDivider(Modifier.padding(top = 12.dp))
    Text(
        title.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp),
    )
}

@Composable
private fun EmptyText(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

/**
 * SwiftUI `LabeledContent`: label leading, value trailing. The label is
 * measured first at its intrinsic width (Row measures unweighted
 * children in order), so a long value truncates instead of squeezing
 * the label.
 */
@Composable
private fun LabeledRow(label: String, value: @Composable () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
        Spacer(Modifier.width(12.dp))
        Spacer(Modifier.weight(1f))
        value()
    }
}

@Composable
private fun LabeledRow(label: String, value: String, mono: Boolean = false) {
    LabeledRow(label) {
        Text(
            value,
            style = if (mono) monoStyle(12.sp) else MaterialTheme.typography.bodyMedium,
            color = secondaryTextColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Outline folder (SF `folder`, the web's lucide Folder). Drawn because
 * material-icons-core ships no folder glyph — the same reason the
 * inspector's file tree draws its own (that one is private to the
 * inspector and also has a filled "open" state this row never needs).
 */
@Composable
private fun FolderGlyph(tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val stroke = Stroke(width = 1.3.dp.toPx())
        val radius = CornerRadius(1.5.dp.toPx())
        // The tab (top-left flap), then the body over it.
        drawRoundRect(
            color = tint,
            topLeft = Offset(0f, h * 0.14f),
            size = Size(w * 0.45f, h * 0.3f),
            cornerRadius = radius,
            style = stroke,
        )
        drawRoundRect(
            color = tint,
            topLeft = Offset(0f, h * 0.3f),
            size = Size(w, h * 0.58f),
            cornerRadius = radius,
            style = stroke,
        )
    }
}
