@file:OptIn(ExperimentalFoundationApi::class)

package app.argus.android.ui.inspector

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawStyle
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.AppModel
import app.argus.android.ui.components.AgentTypeGlyph
import app.argus.android.ui.components.DiffBlock
import app.argus.android.ui.components.StatusCircle
import app.argus.android.ui.files.CenteredProgress
import app.argus.android.ui.files.CenteredUnavailable
import app.argus.android.ui.files.formatBytes
import app.argus.android.ui.session.Chevron
import app.argus.android.ui.session.captionStyle
import app.argus.android.ui.session.monoStyle
import app.argus.android.ui.session.secondaryTextColor
import app.argus.android.ui.terminal.TerminalPane
import app.argus.android.ui.session.tertiaryTextColor
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.engine.DiffLines
import app.argus.core.engine.FileReferences
import app.argus.core.engine.ProjectGroups
import app.argus.core.engine.ProjectRef
import app.argus.core.engine.RelativeTime
import app.argus.core.engine.Turn
import app.argus.core.model.AgentType
import app.argus.core.model.FSEntry
import app.argus.core.model.FSEntryKind
import app.argus.core.model.GitCommit
import app.argus.core.model.GitLogResponse
import app.argus.core.model.GitStatus
import app.argus.core.model.ISO8601
import app.argus.core.model.MachineStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

// The session inspector — the Android counterpart of the web's ContextPane
// and a port of apps/ios/Argus/Sources/Views/InspectorPane.swift: identity
// header + Commits / Files / Terminal / Note / Diff tabs. Every pane is
// project-addressed (ProjectRef) since the runner refactor retired the
// Agent entity. The pane joins the project socket room while visible
// (runner sidecars nudge only that room) so fs/git change events refresh
// the panels live.

private enum class InspectorTab(val label: String) {
    COMMITS("Commits"),
    FILES("Files"),
    TERMINAL("Terminal"),
    NOTE("Note"),
    DIFF("Diff"),
}

/**
 * Right/bottom inspector for one session. Expects a BOUNDED height from
 * its host (a pane or a sheet): the Files and Commits tabs are lazy
 * lists, which cannot measure inside an unbounded scroll.
 *
 * Tabs follow the web ContextPane order — Commits, Files, Terminal,
 * Note, Diff. Terminal appears only for projects whose runner has the
 * PTY opt-in (`Project.supportsTerminal` on the hydrated row — the
 * runner opens PTYs by cwd, the Agent row that used to own them is
 * gone); the extension tabs gate on the account-level flags, Note
 * additionally on a resolved project because it is project-scoped.
 *
 * [onOpenFile] receives the RAW path and a line (always null from the
 * tree); the caller resolves it against the workspace and opens the
 * preview, exactly as it does for FileChips and answer citations — one
 * open path for all three sources.
 */
@Composable
fun InspectorPane(
    app: AppModel,
    sessionId: String,
    onOpenFile: (path: String, line: Int?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val sessions by app.sessionList.sessions.collectAsState()
    val projects by app.fleet.projects.collectAsState()
    val machines by app.fleet.machines.collectAsState()
    val extensions by app.extensions.collectAsState()

    val session = sessions[sessionId]
    val agentType: AgentType = session?.cliType ?: "custom"
    // Project addressing for Files/Commits/Note/Terminal; null for
    // workdir-less sessions (those panes have no surface there).
    val projectRef: ProjectRef? = remember(session?.projectId, projects) { app.fleet.projectRef(session) }
    // The hydrated Project row for `projectRef` (pair-keyed store).
    val projectRow = projectRef?.let { projects[ProjectGroups.projectKey(it.machineId, it.workingDir)] }
    val supportsTerminal = projectRow?.supportsTerminal == true
    val machine = projectRef?.let { machines[it.machineId] }

    val tabs = remember(supportsTerminal, extensions, projectRef != null) {
        buildList {
            add(InspectorTab.COMMITS)
            add(InspectorTab.FILES)
            if (supportsTerminal) add(InspectorTab.TERMINAL)
            if (extensions.notes && projectRef != null) add(InspectorTab.NOTE)
            if (extensions.diff) add(InspectorTab.DIFF)
        }
    }
    var tab by remember { mutableStateOf(InspectorTab.COMMITS) }
    // A toggled-off extension can strand the selection: fall back to
    // Commits, and render the fallback on the same frame so there is no
    // one-frame flash of a tab that no longer exists.
    LaunchedEffect(tabs) { if (tab !in tabs) tab = InspectorTab.COMMITS }
    val current = if (tab in tabs) tab else InspectorTab.COMMITS

    // Join the project room — runner sidecars broadcast fs/git nudges
    // there, keyed by the (machineId, workingDir) pair. Re-keyed on the
    // ref so a store hydrating (or re-resolving) while the inspector is
    // open keeps membership in step, like the web effect's dependency
    // array. StreamClient refcounts, so overlapping holders are safe.
    DisposableEffect(projectRef) {
        val ref = projectRef
        if (ref != null) app.stream?.joinProject(ref.machineId, ref.workingDir)
        onDispose {
            if (ref != null) app.stream?.leaveProject(ref.machineId, ref.workingDir)
        }
    }

    Column(modifier) {
        InspectorHeader(
            agentType = agentType,
            title = projectRow?.name?.takeIf { it.isNotEmpty() }
                ?: projectRef?.workingDir?.takeIf { it.isNotEmpty() }?.let { ProjectGroups.basename(it) }
                ?: "session",
            machineName = machine?.name,
            machineOnline = machine?.status == MachineStatus.ONLINE,
            workingDir = projectRef?.workingDir,
        )
        TabRow(selectedTabIndex = tabs.indexOf(current)) {
            for (entry in tabs) {
                Tab(
                    selected = entry == current,
                    onClick = { tab = entry },
                    text = {
                        Text(entry.label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
                    },
                )
            }
        }
        Box(Modifier.fillMaxWidth().weight(1f)) {
            when (current) {
                InspectorTab.COMMITS -> if (projectRef != null) {
                    CommitsPanel(app = app, project = projectRef)
                } else {
                    NoProjectPlaceholder()
                }
                InspectorTab.FILES -> if (projectRef != null) {
                    FileTreePanel(app = app, project = projectRef, onOpenFile = onOpenFile)
                } else {
                    NoProjectPlaceholder()
                }
                InspectorTab.TERMINAL -> if (projectRef != null) {
                    TerminalPane(app = app, project = projectRef, machineName = machine?.name)
                } else {
                    NoProjectPlaceholder()
                }
                InspectorTab.NOTE -> if (projectRef != null) {
                    NotePanel(app = app, project = projectRef)
                } else {
                    NoProjectPlaceholder()
                }
                InspectorTab.DIFF -> DiffPanel(
                    app = app,
                    sessionId = sessionId,
                    agentType = agentType,
                    workingDir = projectRef?.workingDir,
                )
            }
        }
    }
}

/**
 * Header identity: the session's pinned cliType + the project's name
 * (the user-picked `Project.name` when set, else the basename — the
 * same rule the session list groups by), the machine and its liveness,
 * and the working dir head-truncated so the leaf stays readable.
 */
@Composable
private fun InspectorHeader(
    agentType: AgentType,
    title: String,
    machineName: String?,
    machineOnline: Boolean,
    workingDir: String?,
) {
    val palette = argusPalette
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            AgentTypeGlyph(type = agentType)
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (!machineName.isNullOrEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                StatusCircle(
                    color = if (machineOnline) palette.statusDone else secondaryTextColor.copy(alpha = 0.4f),
                    modifier = Modifier.size(6.dp),
                )
                Text(machineName, style = captionStyle(), color = secondaryTextColor, maxLines = 1)
            }
        }
        if (!workingDir.isNullOrEmpty()) {
            Text(
                text = workingDir,
                style = monoStyle(11.sp),
                color = tertiaryTextColor,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.StartEllipsis,
            )
        }
    }
}

@Composable
private fun NoProjectPlaceholder() {
    CenteredUnavailable("No project", "This session isn't pinned to a working directory.")
}

/**
 * Branch badge — the web tree/log header's `arrow.branch` chip. Amber
 * when detached (web parity: the short SHA stands in for a branch name).
 * The core icon set has no branch glyph, so a tiny caption labels it.
 */
@Composable
private fun RowScope.BranchBadge(git: GitStatus?) {
    if (git == null) {
        Spacer(Modifier.weight(1f))
        return
    }
    val label = if (git.detached) git.head else (git.branch ?: git.head)
    Text(
        text = if (git.detached) "HEAD" else "branch",
        style = captionStyle().copy(fontSize = 10.sp),
        color = tertiaryTextColor,
        maxLines = 1,
    )
    Text(
        text = label,
        modifier = Modifier.weight(1f),
        style = monoStyle(11.sp),
        color = if (git.detached) argusPalette.toolAmber else secondaryTextColor,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Ellipsis,
    )
}

// MARK: - Files

/**
 * Directory levels fetched per round trip (web TREE_PREFETCH_DEPTH): root
 * + two more are warm before the first tap. Raising it trades larger
 * payloads and more sidecar stat calls for deeper instant expansion; the
 * sidecar bounds deeper traversal itself so a pathological tree still
 * terminates.
 */
private const val TREE_PREFETCH_DEPTH = 3

private data class DirState(
    val entries: List<FSEntry> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

/**
 * The tree's state + fetch logic, kept out of the composable so the
 * click handlers, the fs-changed collector and the initial load all
 * mutate ONE set of snapshot-backed fields (a `remember`ed instance per
 * project). Keyed by path relative to the workingDir ("" = root).
 * Entries survive collapse on purpose — re-expanding renders from cache
 * (the cursor-style explorer UX the web keeps too).
 */
private class FileTreeModel(
    private val app: AppModel,
    private val project: ProjectRef,
    private val scope: CoroutineScope,
) {
    val dirs = mutableStateMapOf<String, DirState>()
    var expanded by mutableStateOf(setOf(""))
        private set
    var showAll by mutableStateOf(false)
        private set
    var git by mutableStateOf<GitStatus?>(null)
        private set

    suspend fun fetchDir(path: String, depth: Int = 1) {
        val client = app.client ?: return
        dirs[path] = (dirs[path] ?: DirState()).copy(loading = true, error = null)
        try {
            val response = client.listProjectDir(
                projectId = project.projectId,
                path = path,
                showAll = showAll,
                depth = depth,
            )
            // Depth>1 responses hydrate every level the sidecar walked so
            // the next few expansions render from cache; depth=1
            // responses land in `entries` only.
            response.listings?.forEach { (listedPath, entries) ->
                dirs[listedPath] = DirState(entries = entries)
            }
            if (response.listings?.get(path) == null) {
                dirs[path] = DirState(entries = response.entries)
            }
            if (path.isEmpty()) git = response.git
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            app.handleApiError(e)
            dirs[path] = (dirs[path] ?: DirState()).copy(
                loading = false,
                error = (e as? ApiError)?.message ?: e.message ?: "listing failed",
            )
        }
    }

    /**
     * Refresh = start over: collapse to the root and re-pull the
     * prefetch window (web refreshAll). Simpler than refetching every
     * expanded level in parallel, and what most tree explorers do.
     */
    fun refreshAll() {
        dirs.clear()
        expanded = setOf("")
        git = null
        scope.launch { fetchDir("", TREE_PREFETCH_DEPTH) }
    }

    /**
     * The "show gitignored" toggle costs a refetch: ignored entries are
     * dropped SERVER-side, so the client holds nothing it could reveal
     * (see the `ShowAll` gotcha in AGENTS.md — it is a display switch on
     * the sidecar, never a traversal switch).
     */
    fun toggleShowAll() {
        showAll = !showAll
        refreshAll()
    }

    fun toggle(path: String) {
        if (path in expanded) {
            expanded = expanded - path
            return
        }
        expanded = expanded + path
        val cached = dirs[path]
        if (cached == null) {
            // Cold expansion — outside the prefetch window. Pull
            // TREE_PREFETCH_DEPTH more levels from here so the next few
            // taps are instant too.
            scope.launch { fetchDir(path, TREE_PREFETCH_DEPTH) }
        } else if (!cached.loading && hasUnwalkedSubdir(cached.entries, path)) {
            // Cached — the folder renders instantly, but slide the
            // prefetch frontier when some child dir hasn't been walked
            // yet, so the user's next tap stays on warm cache. The
            // spinner next to the folder honestly reflects that deeper
            // levels are loading.
            scope.launch { fetchDir(path, TREE_PREFETCH_DEPTH) }
        }
    }

    /** `fs:changed` names directories; refetch exactly the LOADED levels it names (depth 1). */
    fun onFsChanged(paths: List<String>) {
        for (path in paths) {
            if (dirs.containsKey(path)) scope.launch { fetchDir(path) }
        }
    }

    /**
     * True when at least one subdirectory has no cached listing yet.
     * Ignored entries are skipped to match the sidecar's BFS, which also
     * refuses to descend into them.
     */
    private fun hasUnwalkedSubdir(entries: List<FSEntry>, parent: String): Boolean =
        entries.any { entry ->
            entry.kind == FSEntryKind.DIR && entry.gitignored != true &&
                !dirs.containsKey(childPath(parent, entry.name))
        }

    /**
     * The recursive tree flattened for LazyColumn (which can't recurse).
     * Message rows carry a per-level error or "(empty)" placeholder,
     * like the web's inline states.
     */
    fun nodes(): List<TreeNode> {
        val out = ArrayList<TreeNode>()
        fun walk(dirPath: String, depth: Int) {
            val state = dirs[dirPath] ?: return
            for (entry in state.entries) {
                val path = childPath(dirPath, entry.name)
                out += TreeNode.Entry(path = path, entry = entry, depth = depth)
                if (entry.kind != FSEntryKind.DIR || path !in expanded) continue
                val child = dirs[path]
                val childError = child?.error
                when {
                    childError != null ->
                        out += TreeNode.Message(id = "$path#error", text = childError, isError = true, depth = depth + 1)
                    child != null && !child.loading && child.entries.isEmpty() ->
                        out += TreeNode.Message(id = "$path#empty", text = "(empty)", isError = false, depth = depth + 1)
                    else -> walk(path, depth + 1)
                }
            }
        }
        walk("", 0)
        return out
    }

    private fun childPath(parent: String, name: String): String =
        if (parent.isEmpty()) name else "$parent/$name"
}

private sealed interface TreeNode {
    val id: String
    val depth: Int

    data class Entry(val path: String, val entry: FSEntry, override val depth: Int) : TreeNode {
        override val id: String get() = path
    }

    data class Message(
        override val id: String,
        val text: String,
        val isError: Boolean,
        override val depth: Int,
    ) : TreeNode
}

/**
 * Compact lazy-expanding file tree — the Android port of the web
 * FileTree / iOS FileTreePanel. Rows are chevron · icon · name in
 * caption-mono at a fixed 24 dp, indented 12 dp per level, no
 * separators. Cold expansions pull [TREE_PREFETCH_DEPTH] levels in one
 * round trip and hydrate a flat `path → DirState` cache so the next taps
 * render synchronously; collapse keeps the cache so re-expanding is
 * instant. `fs:changed` refetches exactly the loaded level it names.
 * Size/mtime live in the row's long-press menu (the web keeps them in
 * tooltips). Tapping a file hands its workspace-relative path to
 * [onOpenFile].
 */
@Composable
private fun FileTreePanel(app: AppModel, project: ProjectRef, onOpenFile: (String, Int?) -> Unit) {
    val scope = rememberCoroutineScope()
    // A fresh model per project: entries from one working dir are
    // nonsense for another.
    val model = remember(project.projectId) { FileTreeModel(app, project, scope) }
    LaunchedEffect(model) { model.fetchDir("", TREE_PREFETCH_DEPTH) }

    // Watch the BATCH, not a single payload: repeat writes to one
    // directory are identical values a StateFlow would collapse, and a
    // burst arrives as one sequence-numbered flush carrying several
    // directories (see AppModel.fsChanges). `drop(1)` skips the batch
    // that predates this panel.
    LaunchedEffect(model) {
        app.fsChanges.drop(1).collect { batch ->
            model.onFsChanged(batch.pathsFor(project.machineId, project.workingDir))
        }
    }

    Column(Modifier.fillMaxSize()) {
        // Branch badge + gitignored toggle + refresh — the web tree's
        // header row. The drill-down breadcrumb is gone; a tree needs none.
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 12.dp, end = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BranchBadge(git = model.git)
            // Text action: the core icon set ships no eye glyph.
            TextButton(onClick = { model.toggleShowAll() }) {
                Text(
                    if (model.showAll) "Hide ignored" else "Show ignored",
                    style = MaterialTheme.typography.labelSmall,
                    color = secondaryTextColor,
                )
            }
            RefreshAction(loading = model.dirs[""]?.loading == true, onClick = { model.refreshAll() })
        }
        HorizontalDivider()

        val root = model.dirs[""]
        when {
            root == null || (root.loading && root.entries.isEmpty() && root.error == null) -> CenteredProgress()
            root.error != null && root.entries.isEmpty() -> CenteredUnavailable("Couldn't list files", root.error)
            root.entries.isEmpty() -> CenteredUnavailable("Empty directory", null)
            else -> {
                val nodes = model.nodes()
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(vertical = 4.dp),
                ) {
                    items(nodes, key = { it.id }) { node ->
                        when (node) {
                            is TreeNode.Entry -> EntryRow(node = node, model = model, onOpenFile = onOpenFile)
                            is TreeNode.Message -> MessageRow(node = node)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RefreshAction(loading: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = !loading, modifier = Modifier.size(32.dp)) {
        if (loading) {
            CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
        } else {
            Icon(
                Icons.Default.Refresh,
                contentDescription = "Refresh",
                modifier = Modifier.size(14.dp),
                tint = secondaryTextColor,
            )
        }
    }
}

/**
 * One tree row. Tap toggles a directory or opens a file; long-press on
 * a file shows size · mtime and a copy-path action — the iOS context
 * menu, the web's title tooltip. Gitignored entries render dimmed.
 */
@Composable
private fun EntryRow(node: TreeNode.Entry, model: FileTreeModel, onOpenFile: (String, Int?) -> Unit) {
    val entry = node.entry
    val isDir = entry.kind == FSEntryKind.DIR
    val isOpen = isDir && node.path in model.expanded
    val loading = isDir && model.dirs[node.path]?.loading == true
    val context = LocalContext.current
    var menuOpen by remember { mutableStateOf(false) }

    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(24.dp)
                .combinedClickable(
                    onClick = { if (isDir) model.toggle(node.path) else onOpenFile(node.path, null) },
                    onLongClick = { if (!isDir) menuOpen = true },
                )
                .alpha(if (entry.gitignored == true) 0.55f else 1f)
                .padding(start = 8.dp + 12.dp * node.depth, end = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TreeChevron(open = isOpen, visible = isDir)
            EntryGlyph(entry = entry, open = isOpen)
            Text(
                text = entry.name,
                modifier = Modifier.weight(1f),
                style = monoStyle(12.sp),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
            if (loading) {
                CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.5.dp)
            }
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text("Copy path") },
                onClick = {
                    menuOpen = false
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    clipboard?.setPrimaryClip(ClipData.newPlainText("path", node.path))
                },
            )
            DropdownMenuItem(
                text = {
                    Text(
                        "${formatBytes(entry.size)} · ${formatAbsoluteTime(entry.mtime)}",
                        style = captionStyle(),
                        color = secondaryTextColor,
                    )
                },
                onClick = {},
                enabled = false,
            )
        }
    }
}

@Composable
private fun MessageRow(node: TreeNode.Message) {
    Text(
        text = node.text,
        modifier = Modifier
            .fillMaxWidth()
            .height(22.dp)
            .padding(start = 8.dp + 12.dp * node.depth + 24.dp, end = 12.dp),
        style = monoStyle(11.sp),
        color = if (node.isError) argusPalette.statusFailed else secondaryTextColor,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** Right-pointing chevron that turns down when open; kept in the layout (invisible) for files so names align. */
@Composable
private fun TreeChevron(open: Boolean, visible: Boolean) {
    val angle by animateFloatAsState(targetValue = if (open) 90f else 0f, label = "tree-chevron")
    Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        modifier = Modifier
            .size(12.dp)
            .rotate(angle)
            .alpha(if (visible) 1f else 0f),
        tint = tertiaryTextColor,
    )
}

/**
 * Per-kind glyph. Only material-icons-core is a dependency (no folder,
 * link or document glyphs), so the folder is drawn — outline closed,
 * filled open, the web's Folder/FolderOpen — files reuse the "lines of
 * text" glyph FileChips uses, and a symlink is an arrow in the purple
 * the web tints it.
 */
@Composable
private fun EntryGlyph(entry: FSEntry, open: Boolean) {
    when (entry.kind) {
        FSEntryKind.DIR -> FolderGlyph(open = open, tint = argusPalette.mdLink.copy(alpha = 0.85f))
        FSEntryKind.SYMLINK -> Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = null,
            modifier = Modifier.size(12.dp),
            tint = Color(0xFFA855F7).copy(alpha = 0.8f),
        )
        FSEntryKind.FILE, FSEntryKind.UNKNOWN -> Icon(
            imageVector = Icons.AutoMirrored.Filled.List,
            contentDescription = null,
            modifier = Modifier.size(12.dp),
            tint = tertiaryTextColor,
        )
    }
}

@Composable
private fun FolderGlyph(open: Boolean, tint: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(13.dp)) {
        val w = size.width
        val h = size.height
        val style: DrawStyle = if (open) Fill else Stroke(width = 1.2.dp.toPx())
        val radius = CornerRadius(1.5.dp.toPx())
        // The tab (top-left flap), then the body over it.
        drawRoundRect(
            color = tint,
            topLeft = Offset(0f, h * 0.12f),
            size = Size(w * 0.45f, h * 0.3f),
            cornerRadius = radius,
            style = style,
        )
        drawRoundRect(
            color = tint,
            topLeft = Offset(0f, h * 0.3f),
            size = Size(w, h * 0.6f),
            cornerRadius = radius,
            style = style,
        )
    }
}

// MARK: - Commits

/**
 * Compact commit log — the web GitLogPanel: branch badge + refresh up
 * top, then dense mono `sha · subject · age` rows with no separators.
 * Long-press a row for the author, absolute date, and copy-SHA (the web
 * keeps those in the row tooltip). Refetches on a `git:changed` nudge
 * for this project — the per-workdir gitWatcher is the only producer of
 * that event, by design (see the `vcs_state_changed` gotcha).
 */
@Composable
private fun CommitsPanel(app: AppModel, project: ProjectRef) {
    val scope = rememberCoroutineScope()
    var response by remember(project.projectId) { mutableStateOf<GitLogResponse?>(null) }
    var loadError by remember(project.projectId) { mutableStateOf<String?>(null) }
    var loading by remember(project.projectId) { mutableStateOf(false) }

    suspend fun load() {
        val client = app.client ?: return
        loading = true
        try {
            response = client.getProjectGitLog(project.projectId, limit = 50)
            loadError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            app.handleApiError(e)
            loadError = (e as? ApiError)?.message ?: e.message ?: "Couldn't load commits"
        } finally {
            loading = false
        }
    }

    LaunchedEffect(project.projectId) { load() }
    // `drop(1)`: the event already in the flow (or its initial null)
    // predates this panel; only later nudges for THIS project reload.
    LaunchedEffect(project) {
        app.gitChanges.drop(1).collect { event ->
            if (event != null && event.matches(project.machineId, project.workingDir)) load()
        }
    }

    val current = response
    val error = loadError
    when {
        current != null -> Column(Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BranchBadge(git = current.git)
                RefreshAction(loading = loading, onClick = { scope.launch { load() } })
            }
            HorizontalDivider()
            if (current.commits.isEmpty()) {
                CenteredUnavailable("No commits", "Not a git repo, or no commits yet.")
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(vertical = 4.dp),
                ) {
                    items(current.commits, key = { it.sha }) { commit -> CommitRow(commit) }
                }
            }
        }
        error != null -> Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.weight(1f)) { CenteredUnavailable("Couldn't load commits", error) }
            TextButton(onClick = { scope.launch { load() } }, modifier = Modifier.padding(bottom = 12.dp)) {
                Text("Retry", style = MaterialTheme.typography.labelMedium)
            }
        }
        else -> CenteredProgress()
    }
}

/** One-line commit row: shortSha · subject · terse age, all mono, at a fixed 24 dp. */
@Composable
private fun CommitRow(commit: GitCommit) {
    val context = LocalContext.current
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(24.dp)
                .combinedClickable(onClick = {}, onLongClick = { menuOpen = true })
                .padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(commit.shortSha, style = monoStyle(11.sp), color = tertiaryTextColor, maxLines = 1)
            Text(
                text = commit.subject,
                modifier = Modifier.weight(1f),
                style = monoStyle(12.sp),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = RelativeTime.short(commit.authorDate),
                style = monoStyle(11.sp).copy(fontFeatureSettings = "tnum"),
                color = tertiaryTextColor,
                maxLines = 1,
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text("Copy SHA") },
                onClick = {
                    menuOpen = false
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    clipboard?.setPrimaryClip(ClipData.newPlainText("sha", commit.sha))
                },
            )
            val absolute = ISO8601.parseMillis(commit.authorDate)?.let { formatAbsoluteTime(it) } ?: commit.authorDate
            DropdownMenuItem(
                text = {
                    Text(
                        listOf(commit.authorName, absolute).filter { it.isNotEmpty() }.joinToString(" · "),
                        style = captionStyle(),
                        color = secondaryTextColor,
                    )
                },
                onClick = {},
                enabled = false,
            )
        }
    }
}

/** Locale-formatted absolute timestamp for the long-press menus (the web's `toLocaleString`). */
private fun formatAbsoluteTime(millis: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(millis))

// MARK: - Note (per-project scratchpad)

/**
 * Server-side cap on a project note, mirrored from
 * `PROJECT_NOTES_MAX_BYTES` in packages/shared-types/src/api.ts. Checked
 * in BYTES, like the web, so multi-byte text can't sneak past the
 * server's rejection; the visible counter shows characters.
 */
private const val PROJECT_NOTES_MAX_BYTES = 32_768

/** The web's ~700 ms autosave pause. */
private const val NOTE_AUTOSAVE_MS = 700L

private sealed interface NoteSaveState {
    data object Idle : NoteSaveState
    data object Unsaved : NoteSaveState
    data object Saving : NoteSaveState
    data object Saved : NoteSaveState
    data class Failed(val message: String) : NoteSaveState
}

/**
 * Notes extension: a free-form scratchpad scoped to the project. The
 * wire is keyed by (machineId, workingDir), so every session in the
 * same directory — on any client — edits the same note; it is personal
 * (per user) and never fanned out to sidecars.
 *
 * Autosave on a debounce rather than behind a Save button: a side-panel
 * scratchpad you have to remember to save is one you lose. This
 * debounce RESTARTS on every keystroke — the one place in the app where
 * restarting is right, because an autosave should wait for quiet and
 * PUT once per pause (the file-refresh window is the opposite case;
 * see FilePreviewSheet). Realised as a `LaunchedEffect` keyed on the
 * text: a new key cancels the pending delay, so only the last edit in a
 * burst reaches the server.
 */
@Composable
private fun NotePanel(app: AppModel, project: ProjectRef) {
    val key = project.machineId to project.workingDir
    var text by remember(key) { mutableStateOf("") }
    var savedText by remember(key) { mutableStateOf("") }
    var loaded by remember(key) { mutableStateOf(false) }
    var loadError by remember(key) { mutableStateOf<String?>(null) }
    var saveState by remember(key) { mutableStateOf<NoteSaveState>(NoteSaveState.Idle) }

    val byteCount = remember(text) { text.toByteArray(Charsets.UTF_8).size }
    val overLimit = byteCount > PROJECT_NOTES_MAX_BYTES
    val dirty = text != savedText

    LaunchedEffect(key) {
        val client = app.client ?: return@LaunchedEffect
        try {
            val notes = client.getProjectNotes(project.machineId, project.workingDir)
            text = notes
            savedText = notes
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            app.handleApiError(e)
            loadError = (e as? ApiError)?.message ?: e.message ?: "Couldn't load note"
        }
        loaded = true
    }

    // Skipped while loading, when nothing changed, or over the byte cap
    // (the server would reject it anyway) — web parity.
    LaunchedEffect(text, loaded) {
        if (!loaded || loadError != null || !dirty || overLimit) return@LaunchedEffect
        val client = app.client ?: return@LaunchedEffect
        saveState = NoteSaveState.Unsaved
        delay(NOTE_AUTOSAVE_MS)
        saveState = NoteSaveState.Saving
        val sent = text
        try {
            client.setProjectNotes(project.machineId, project.workingDir, sent)
            // What we sent, not the echo: a server-side normalisation
            // would otherwise leave the note permanently "dirty".
            savedText = sent
            saveState = NoteSaveState.Saved
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            app.handleApiError(e)
            saveState = NoteSaveState.Failed((e as? ApiError)?.message ?: e.message ?: "save failed")
        }
    }

    if (!loaded) {
        CenteredProgress()
        return
    }
    val error = loadError
    if (error != null) {
        CenteredUnavailable("Couldn't load note", error)
        return
    }

    val palette = argusPalette
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f),
            placeholder = {
                Text(
                    "Notes for this project — TODOs, context, links, anything worth keeping next to the work.",
                    style = MaterialTheme.typography.bodySmall,
                )
            },
            textStyle = MaterialTheme.typography.bodyMedium,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 6.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "${text.length} / $PROJECT_NOTES_MAX_BYTES",
                style = monoStyle(11.sp).copy(fontFeatureSettings = "tnum"),
                color = if (overLimit) palette.statusFailed else tertiaryTextColor,
                maxLines = 1,
            )
            val (status, color) = when {
                overLimit -> "too long to save" to palette.statusFailed
                else -> when (val state = saveState) {
                    NoteSaveState.Idle -> "" to tertiaryTextColor
                    NoteSaveState.Unsaved -> "unsaved…" to tertiaryTextColor
                    NoteSaveState.Saving -> "saving…" to tertiaryTextColor
                    NoteSaveState.Saved -> "saved" to palette.statusDone
                    is NoteSaveState.Failed -> "save failed: ${state.message}" to palette.statusFailed
                }
            }
            Text(
                text = status,
                style = captionStyle().copy(fontSize = 11.sp),
                color = color,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(
            text = "Shared by every session in ${ProjectGroups.basename(project.workingDir)} — synced to your account.",
            modifier = Modifier.padding(top = 2.dp),
            style = captionStyle().copy(fontSize = 11.sp),
            color = tertiaryTextColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// MARK: - Diff (last turn)

private data class FileDiff(
    val path: String,
    val text: String,
    val added: Int,
    val removed: Int,
)

/**
 * Last-turn file diffs, aggregated client-side from the transcript's
 * `meta.isDiff` chunks — the same derivation as the web's DiffPane and
 * the iOS DiffPanel, no new capture. Reads the session view-model's
 * live turns, so it updates while a turn is still editing. Each file is
 * collapsible (state keyed by the stable absolute path, so it survives
 * the live re-derivation) and its body sits in a 320 dp scroll box so
 * one huge patch can't push the other files off-screen — `DiffBlock`'s
 * default cap is exactly that box.
 */
@Composable
private fun DiffPanel(app: AppModel, sessionId: String, agentType: AgentType, workingDir: String?) {
    // Cached-or-new, like SessionScreen: the on-screen session's VM is
    // already loaded and streaming, this only observes it.
    val model = remember(sessionId, agentType) { app.sessionViewModel(sessionId, agentType) }
    if (model == null) {
        CenteredUnavailable("No transcript", "Not connected.")
        return
    }
    val turns by model.turns.collectAsState()
    val diffs = remember(turns) { lastTurnDiffs(turns) }
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    val palette = argusPalette

    if (diffs.isEmpty()) {
        CenteredUnavailable("No diffs in the last turn", "File edits made by the agent show up here.")
        return
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        for (diff in diffs) {
            key(diff.path) {
                val isCollapsed = collapsed[diff.path] == true
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { collapsed[diff.path] = !isCollapsed }
                            .padding(vertical = 2.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Chevron(open = !isCollapsed, size = 12.dp)
                        Text(
                            text = FileReferences.displayPath(diff.path, workingDir),
                            modifier = Modifier.weight(1f),
                            style = monoStyle(11.sp),
                            color = MaterialTheme.colorScheme.onSurface,
                            maxLines = 1,
                            softWrap = false,
                            overflow = TextOverflow.StartEllipsis,
                        )
                        Text("+${diff.added}", style = captionStyle().copy(fontSize = 11.sp), color = palette.diffAddFg)
                        // U+2212 minus lines up with the plus in a mono face.
                        Text("−${diff.removed}", style = captionStyle().copy(fontSize = 11.sp), color = palette.diffRemoveFg)
                    }
                    if (!isCollapsed) {
                        DiffBlock(diff = diff.text, maxHeight = 320.dp)
                    }
                }
            }
        }
    }
}

/**
 * The most recent turn that carries a diff, grouped by file in
 * first-seen order. Diffs ride the tool row (paired result), so
 * `diffBody` is the result text falling back to the row's own content.
 */
private fun lastTurnDiffs(turns: List<Turn>): List<FileDiff> {
    val turn = turns.lastOrNull { t -> t.timeline.any { it.isDiff } } ?: return emptyList()
    val byPath = LinkedHashMap<String, MutableList<String>>()
    for (item in turn.timeline) {
        if (!item.isDiff) continue
        byPath.getOrPut(item.filePath ?: "unknown") { ArrayList() } += item.diffBody
    }
    return byPath.map { (path, bodies) ->
        val text = bodies.joinToString("\n")
        val counts = DiffLines.counts(text)
        FileDiff(path = path, text = text, added = counts.added, removed = counts.removed)
    }
}
