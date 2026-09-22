@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package app.argus.android.ui.session

import android.view.KeyCharacterMap
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.argus.android.AppModel
import app.argus.android.HotkeyBinding
import app.argus.android.Hotkeys
import app.argus.android.Route
import app.argus.android.session.SessionViewModel
import app.argus.android.ui.components.ConnectionBanner
import app.argus.android.ui.components.FileChipsRow
import app.argus.android.ui.files.AttachmentPreviewSheet
import app.argus.android.ui.files.FilePreviewSheet
import app.argus.android.ui.files.FilePreviewTarget
import app.argus.android.ui.inspector.InspectorPane
import app.argus.android.ui.markdown.AnswerView
import app.argus.android.ui.markdown.MarkdownImageContext
import app.argus.android.ui.sessions.RenameDialog
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.engine.FileReferences
import app.argus.core.engine.ProjectRef
import app.argus.core.engine.QueuedPrompt
import app.argus.core.engine.Turn
import app.argus.core.model.AttachmentDTO
import app.argus.core.model.KnownAgentType
import kotlinx.coroutines.launch

/**
 * One session: the streaming transcript above the composer, with the
 * inspector alongside (wide) or as a sheet (compact). Port of
 * SessionView.swift.
 *
 * [showBack] is false in the tablet split layout, where the session
 * list column stays on screen and there is nothing to go back to.
 */
@Composable
fun SessionScreen(app: AppModel, sessionId: String, onBack: () -> Unit, showBack: Boolean = true) {
    val sessions by app.sessionList.sessions.collectAsState()
    val projects by app.fleet.projects.collectAsState()
    val session = sessions[sessionId]
    val agentType = session?.cliType ?: "custom"
    val projectRef: ProjectRef? = remember(session?.projectId, projects) { app.fleet.projectRef(session) }
    val workingDir = projectRef?.workingDir
    val scope = rememberCoroutineScope()

    // Cached-or-new; re-keyed on agentType so a VM built with the
    // "custom" fallback is replaced once the real type hydrates.
    val model = remember(sessionId, agentType) { app.sessionViewModel(sessionId, agentType) }

    // start() re-runs on every appearance: it is idempotent (re-join
    // room + revalidate), which both serves cache re-opens and restores
    // room membership after a disappear/reappear.
    DisposableEffect(model) {
        if (model != null) {
            app.activeSession = model
            app.sessionList.markSeenLocally(sessionId)
        }
        onDispose {
            model?.stop()
            if (app.activeSession === model) app.activeSession = null
        }
    }
    LaunchedEffect(model) { model?.start() }

    var menuOpen by remember { mutableStateOf(false) }
    var showRename by remember { mutableStateOf(false) }
    var showModelPicker by remember { mutableStateOf(false) }
    var inspectorOpen by rememberSaveable { mutableStateOf(false) }
    var filePreview by remember { mutableStateOf<FilePreviewTarget?>(null) }
    var attachmentPreview by remember { mutableStateOf<AttachmentDTO?>(null) }
    /** One archive/unarchive request at a time — Ctrl+D is a toggle, and a double-press must not race two flips. */
    var archiveBusy by remember { mutableStateOf(false) }
    var forkBusy by remember { mutableStateOf(false) }
    val isRunning = if (model != null) model.isRunning.collectAsState().value else false
    val usage = if (model != null) model.usage.collectAsState().value else null
    val context = if (model != null) model.context.collectAsState().value else null
    val archived = session?.archivedAt != null

    fun setArchived(target: Boolean) {
        val client = app.client ?: return
        if (archiveBusy) return
        archiveBusy = true
        scope.launch {
            try {
                val updated = if (target) client.archiveSession(sessionId) else client.unarchiveSession(sessionId)
                app.sessionList.upsert(updated)
            } catch (e: Exception) {
                app.handleApiError(e)
            } finally {
                archiveBusy = false
            }
        }
    }

    /**
     * Ctrl+D — a TOGGLE that stays on the session (web parity): the undo
     * for a misfire is the same keystroke, and the toolbar badge reports
     * the new state.
     */
    val toggleArchive = rememberUpdatedState<() -> Unit>({ setArchived(!archived) })
    val cancelTurn = rememberUpdatedState<() -> Boolean>({
        if (isRunning && model != null) {
            scope.launch { model.cancelRunningTurn() }
            true
        } else {
            false
        }
    })
    // SESSION-scoped hotkeys are live only while this screen is mounted.
    DisposableEffect(app) {
        val handler: (HotkeyBinding) -> Boolean = { binding ->
            when (binding.id) {
                Hotkeys.archiveSession.id -> {
                    toggleArchive.value()
                    true
                }
                Hotkeys.cancelTurn.id -> cancelTurn.value()
                else -> false
            }
        }
        app.sessionHotkeyHandler = handler
        onDispose { if (app.sessionHotkeyHandler === handler) app.sessionHotkeyHandler = null }
    }

    /**
     * Open a preview for a raw tool/citation path — only when it
     * resolves inside the session's workspace (the sidecar rejects reads
     * outside its jail).
     */
    val openFile: (String, Int?) -> Unit = { raw, line ->
        val relative = FileReferences.toAgentRelative(raw, workingDir)
        if (relative != null && projectRef != null) {
            filePreview = FilePreviewTarget(
                path = relative,
                displayPath = FileReferences.displayPath(raw, workingDir),
                line = line,
            )
        }
    }

    fun fork(turn: Turn) {
        val client = app.client ?: return
        if (forkBusy) return
        forkBusy = true
        scope.launch {
            try {
                // The server holds this call until the CLI-side clone
                // settles (up to 15 s), so the new session is promptable
                // the moment it is announced.
                val forked = client.forkSession(sessionId, turn.id)
                app.sessionList.upsert(forked)
                app.navigate(Route.Session(forked.id))
            } catch (e: Exception) {
                app.handleApiError(e)
                model?.actionError?.value = (e as? ApiError)?.message ?: e.message
            } finally {
                forkBusy = false
            }
        }
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Wide enough for the inspector to sit beside the transcript
        // (the iPad's .inspector column); narrower hosts get a sheet.
        val sideInspector = maxWidth >= 900.dp
        Row(Modifier.fillMaxSize()) {
            Scaffold(
                modifier = Modifier.weight(1f).fillMaxHeight(),
                topBar = {
                    TopAppBar(
                        title = { Text(session?.title ?: "Session", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        navigationIcon = {
                            if (showBack) {
                                IconButton(onClick = onBack) {
                                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                                }
                            }
                        },
                        actions = {
                            // /compact is a REAL client-side command only on
                            // claude-code (codex/cursor print modes role-play
                            // a fake "Compacted." reply), and it can't overlap
                            // a turn.
                            UsageBadge(
                                usage = usage,
                                context = context,
                                onCompact = if (session?.cliType == KnownAgentType.CLAUDE_CODE && !isRunning) {
                                    { app.submitPrompt(sessionId, "/compact", emptyList()) }
                                } else {
                                    null
                                },
                            )
                            if (archived) {
                                // The web's header badge: reports the state
                                // Ctrl+D just set and doubles as the
                                // tap-to-restore affordance.
                                TextButton(onClick = { setArchived(false) }, enabled = !archiveBusy) {
                                    Text("archived", style = MaterialTheme.typography.labelSmall)
                                }
                            }
                            IconButton(onClick = { inspectorOpen = !inspectorOpen }) {
                                Icon(
                                    Icons.Default.Info,
                                    contentDescription = "Inspector",
                                    tint = if (inspectorOpen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Box {
                                IconButton(onClick = { menuOpen = true }) {
                                    Icon(Icons.Default.MoreVert, contentDescription = "More")
                                }
                                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                    DropdownMenuItem(
                                        text = {
                                            Column {
                                                Text("Model…")
                                                Text(
                                                    session?.modelSelection?.summary ?: "CLI default",
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                )
                                            }
                                        },
                                        onClick = { menuOpen = false; showModelPicker = true },
                                    )
                                    DropdownMenuItem(text = { Text("Rename…") }, onClick = { menuOpen = false; showRename = true })
                                    if (session != null) {
                                        DropdownMenuItem(
                                            text = { Text(if (archived) "Unarchive" else "Archive") },
                                            onClick = { menuOpen = false; setArchived(!archived) },
                                        )
                                    }
                                }
                            }
                        },
                    )
                },
            ) { innerPadding ->
                Column(Modifier.padding(innerPadding).fillMaxSize().imePadding()) {
                    ConnectionBanner(app)
                    if (model == null) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                        return@Column
                    }
                    Transcript(
                        app = app,
                        model = model,
                        projectRef = projectRef,
                        forkBusy = forkBusy,
                        onFork = ::fork,
                        onOpenFile = openFile,
                        onOpenAttachment = { attachmentPreview = it },
                        modifier = Modifier.weight(1f),
                    )
                    Composer(app = app, model = model, sessionId = sessionId)
                }
            }
            if (sideInspector && inspectorOpen) {
                VerticalDivider()
                InspectorPane(
                    app = app,
                    sessionId = sessionId,
                    onOpenFile = openFile,
                    modifier = Modifier.width(340.dp).fillMaxHeight(),
                )
            }
        }
        if (!sideInspector && inspectorOpen) {
            ModalBottomSheet(
                onDismissRequest = { inspectorOpen = false },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            ) {
                InspectorPane(
                    app = app,
                    sessionId = sessionId,
                    onOpenFile = openFile,
                    modifier = Modifier.fillMaxWidth().fillMaxHeight(0.92f),
                )
            }
        }
    }

    if (showRename && session != null) {
        RenameDialog(
            initial = session.title,
            onDismiss = { showRename = false },
            onRename = { title ->
                showRename = false
                scope.launch {
                    try {
                        app.client?.renameSession(sessionId, title)?.let { app.sessionList.upsert(it) }
                    } catch (e: Exception) {
                        app.handleApiError(e)
                    }
                }
            },
        )
    }
    if (showModelPicker && session != null) {
        ModelPickerSheet(app = app, session = session, onDismiss = { showModelPicker = false })
    }
    val preview = filePreview
    if (preview != null && projectRef != null) {
        FilePreviewSheet(app = app, project = projectRef, target = preview, onDismiss = { filePreview = null })
    }
    attachmentPreview?.let { attachment ->
        AttachmentPreviewSheet(app = app, attachment = attachment, onDismiss = { attachmentPreview = null })
    }
}

// MARK: Transcript

@Composable
private fun Transcript(
    app: AppModel,
    model: SessionViewModel,
    projectRef: ProjectRef?,
    forkBusy: Boolean,
    onFork: (Turn) -> Unit,
    onOpenFile: (String, Int?) -> Unit,
    onOpenAttachment: (AttachmentDTO) -> Unit,
    modifier: Modifier = Modifier,
) {
    val turns by model.turns.collectAsState()
    val isRunning by model.isRunning.collectAsState()
    val loadState by model.loadState.collectAsState()
    val hasMore by model.hasMoreHistory.collectAsState()
    val loadingOlder by model.loadingOlder.collectAsState()
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val expandedActivity = remember { mutableStateMapOf<String, Boolean>() }

    // Item layout: [history header] + turns + [bottom sentinel].
    val bottomIndex = turns.size + 1
    // "Pinned to bottom" = the sentinel is visible.
    val nearBottom by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            info.visibleItemsInfo.lastOrNull()?.index?.let { it >= info.totalItemsCount - 1 } ?: true
        }
    }

    // Follow a live stream only while the user is at the bottom —
    // scrolled-up reading stays put.
    LaunchedEffect(turns, isRunning) {
        if (turns.isNotEmpty() && isRunning && nearBottom) listState.animateScrollToItem(bottomIndex)
    }
    // First non-empty render (cold load or cache re-open): land at the live edge.
    var landed by remember(model) { mutableStateOf(false) }
    LaunchedEffect(turns.isEmpty()) {
        if (turns.isNotEmpty() && !landed) {
            landed = true
            listState.scrollToItem(bottomIndex)
        }
    }

    Box(modifier.fillMaxWidth()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
        ) {
            item(key = "history") {
                if (hasMore) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                        TextButton(onClick = { scope.launch { model.loadOlder() } }, enabled = !loadingOlder) {
                            if (loadingOlder) {
                                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                            } else {
                                Icon(Icons.Default.KeyboardArrowUp, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("Load earlier turns", style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }
            }
            items(turns, key = { it.id }) { turn ->
                TurnItem(
                    app = app,
                    turn = turn,
                    projectRef = projectRef,
                    timelineExpanded = expandedActivity[turn.id] == true,
                    onToggleTimeline = { expandedActivity[turn.id] = expandedActivity[turn.id] != true },
                    forkBusy = forkBusy,
                    onFork = { onFork(turn) },
                    onOpenFile = onOpenFile,
                    onOpenAttachment = onOpenAttachment,
                )
            }
            item(key = "bottom") { Spacer(Modifier.height(1.dp)) }
        }

        if (turns.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                when (val state = loadState) {
                    SessionViewModel.LoadState.Loading -> CircularProgressIndicator()
                    is SessionViewModel.LoadState.Failed -> EmptyState("Couldn't load transcript", state.message)
                    SessionViewModel.LoadState.Loaded -> EmptyState("No messages yet", "Send a prompt to start the conversation.")
                }
            }
        }
    }
}

@Composable
private fun EmptyState(title: String, detail: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(24.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * One turn: the user message + activity capsule (the web's band), then
 * the panels, the expanded timeline, the answer, touched files, and any
 * error — web order.
 */
@Composable
private fun TurnItem(
    app: AppModel,
    turn: Turn,
    projectRef: ProjectRef?,
    timelineExpanded: Boolean,
    onToggleTimeline: () -> Unit,
    forkBusy: Boolean,
    onFork: () -> Unit,
    onOpenFile: (String, Int?) -> Unit,
    onOpenAttachment: (AttachmentDTO) -> Unit,
) {
    val images = remember(projectRef, turn.command.completedAt) {
        val client = app.client
        MarkdownImageContext(
            projectId = projectRef?.projectId,
            workingDir = projectRef?.workingDir,
            turnEpoch = turn.command.completedAt,
            readFile = { projectId, path ->
                client?.let { runCatching { it.readProjectFile(projectId, path).result }.getOrNull() }
            },
        )
    }

    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (turn.attachments.isNotEmpty()) {
            TurnAttachmentThumbs(
                attachments = turn.attachments,
                absoluteUrl = { path -> app.client?.absoluteUrl(path) },
                onOpen = onOpenAttachment,
            )
        }
        if (turn.prompt.isNotEmpty()) PromptBubble(turn.prompt, forkBusy = forkBusy, onFork = onFork)
        if (turn.timeline.isNotEmpty()) {
            ActivityCapsule(turn = turn, expanded = timelineExpanded, onToggle = onToggleTimeline)
        }

        turn.todos?.let { TodoWindow(it) }
        if (turn.subAgents.isNotEmpty()) SubAgentWindow(turn.subAgents)
        if (turn.timeline.isNotEmpty() && timelineExpanded) ActivityTimeline(turn)

        if (turn.answer.isNotEmpty()) {
            AnswerView(markdown = turn.answer, isStreaming = turn.isRunning, images = images, onOpenFile = onOpenFile)
        } else if (turn.isRunning && turn.timeline.isEmpty() && turn.todos == null && turn.subAgents.isEmpty()) {
            // Only before ANY activity streams — once the capsule or a
            // panel has content, that conveys progress.
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Working…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        if (turn.touchedFiles.isNotEmpty()) {
            FileChipsRow(files = turn.touchedFiles, workingDir = projectRef?.workingDir, onOpen = onOpenFile)
        }

        turn.errorText?.let { error ->
            Text(
                error,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.error.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
                    .padding(8.dp),
            )
        }
    }
}

/**
 * The user message — a soft bubble on surface2, clamped with
 * tap-to-expand. Long-press offers "Fork from here": the web's per-turn
 * branch action, which replays the transcript up to this turn into a
 * new session (the server holds the request until the CLI state is
 * cloned, so the fork is promptable as soon as it appears).
 */
@Composable
private fun PromptBubble(text: String, forkBusy: Boolean, onFork: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(argusPalette.surface2, RoundedCornerShape(14.dp))
                .combinedClickable(onClick = { expanded = !expanded }, onLongClick = { menuOpen = true })
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = if (expanded) Int.MAX_VALUE else 6,
                overflow = TextOverflow.Ellipsis,
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(if (forkBusy) "Branching…" else "Fork from here") },
                enabled = !forkBusy,
                onClick = { menuOpen = false; onFork() },
            )
        }
    }
}

// MARK: Composer

/**
 * The web's rounded composer: paperclip, the auto-growing field, and
 * the send / add-to-queue / stop actions. Submits route through the
 * queue (AppModel.submitPrompt): joining the FIFO tail keeps manual
 * sends from jumping a draining backlog, and the drainer dispatches
 * immediately when the session is free.
 *
 * Hardware keyboard (web Composer parity): Enter sends, Shift+Enter
 * inserts a newline, Escape leaves the field — it never cancels the
 * turn (Ctrl+. does that, from anywhere; a reflex key whose meaning
 * depends on whether something is running is how accidental cancels
 * happen). The on-screen keyboard's Enter keeps inserting newlines: a
 * key event from the virtual keyboard is let through untouched.
 */
@Composable
private fun Composer(app: AppModel, model: SessionViewModel, sessionId: String) {
    val actionError by model.actionError.collectAsState()
    val isRunning by model.isRunning.collectAsState()
    val queueItems by app.queue.items.collectAsState()
    val queued = remember(queueItems) { queueItems.filter { it.sessionId == sessionId } }
    var draft by remember(sessionId) { mutableStateOf("") }
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()
    val uploader = rememberAttachmentUploader(app) { message -> model.actionError.value = message }

    // Running turn OR queued backlog → submits join the queue.
    val busy = isRunning || queued.isNotEmpty()
    val hasContent = draft.isNotBlank() || uploader.pending.isNotEmpty()
    val canSend = hasContent && uploader.inFlight == 0

    fun send() {
        if (!canSend) return
        val text = draft
        val attachmentIds = uploader.takeAll()
        draft = ""
        model.actionError.value = null
        app.submitPrompt(sessionId, text, attachmentIds)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .widthIn(max = 720.dp)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        actionError?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
        if (queued.isNotEmpty()) PromptQueueList(app, queued)
        AttachmentChipsRow(uploader)

        Row(verticalAlignment = Alignment.Bottom) {
            AttachButton(uploader = uploader, enabled = true)
            Spacer(Modifier.width(4.dp))
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text(if (busy) "Queue a follow-up…" else "Request changes or ask a question…") },
                maxLines = 6,
                shape = RoundedCornerShape(22.dp),
                modifier = Modifier
                    .weight(1f)
                    .onPreviewKeyEvent { event ->
                        if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        // The soft keyboard reports the virtual device;
                        // its Enter is a newline, as on iOS.
                        val virtual = event.nativeKeyEvent.deviceId == KeyCharacterMap.VIRTUAL_KEYBOARD
                        when (event.key) {
                            Key.Enter, Key.NumPadEnter -> when {
                                virtual || event.isShiftPressed -> false
                                else -> {
                                    // An unmodified Return is ALWAYS swallowed:
                                    // send() no-ops when there's nothing to
                                    // send, and Enter never newlines.
                                    send()
                                    true
                                }
                            }
                            Key.Escape -> {
                                focusManager.clearFocus()
                                true
                            }
                            else -> false
                        }
                    },
            )
            Spacer(Modifier.width(8.dp))
            if (isRunning) {
                // Web order: add-to-queue (only when there's content) on
                // the LEFT, then the stop button on the RIGHT.
                if (hasContent) {
                    PrimaryAction(icon = Icons.Default.Add, description = "Queue", enabled = canSend, busy = uploader.inFlight > 0) { send() }
                    Spacer(Modifier.width(6.dp))
                }
                // Subtle (surface-2) square, NOT red — matches the web's
                // `variant="subtle"` cancel button.
                IconButton(
                    onClick = { scope.launch { model.cancelRunningTurn() } },
                    modifier = Modifier.size(44.dp).background(argusPalette.surface2, CircleShape),
                ) {
                    Box(Modifier.size(12.dp).background(MaterialTheme.colorScheme.onSurface, RoundedCornerShape(2.dp)))
                }
            } else {
                PrimaryAction(icon = Icons.AutoMirrored.Filled.Send, description = "Send", enabled = canSend, busy = uploader.inFlight > 0) { send() }
            }
        }
    }
}

/** The primary circular action (send when idle, add-to-queue while running). */
@Composable
private fun PrimaryAction(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    description: String,
    enabled: Boolean,
    busy: Boolean,
    onClick: () -> Unit,
) {
    IconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .size(44.dp)
            .background(
                if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f),
                CircleShape,
            ),
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
        } else {
            Icon(
                icon,
                contentDescription = description,
                tint = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * Parked follow-ups for this session, oldest first — editable inline,
 * removable, drained oldest-first by AppModel as the session goes idle.
 */
@Composable
private fun PromptQueueList(app: AppModel, items: List<QueuedPrompt>) {
    var editing by remember { mutableStateOf<QueuedPrompt?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (item in items) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(argusPalette.surface1, RoundedCornerShape(8.dp))
                    .padding(start = 10.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("⏱", style = MaterialTheme.typography.labelSmall)
                Spacer(Modifier.width(6.dp))
                Text(
                    item.text,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { editing = item }, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Default.Edit, contentDescription = "Edit", modifier = Modifier.size(14.dp))
                }
                IconButton(onClick = { app.queue.remove(item.id) }, modifier = Modifier.size(28.dp)) {
                    Icon(Icons.Default.Close, contentDescription = "Remove", modifier = Modifier.size(14.dp))
                }
            }
        }
    }
    editing?.let { target ->
        var text by remember(target.id) { mutableStateOf(target.text) }
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("Edit queued prompt") },
            text = { OutlinedTextField(value = text, onValueChange = { text = it }, maxLines = 6) },
            confirmButton = {
                Button(onClick = {
                    if (text.isNotBlank()) app.queue.update(target.id, text)
                    editing = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
}
