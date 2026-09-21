@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.argus.android.AppModel
import app.argus.android.session.SessionViewModel
import app.argus.android.ui.components.ConnectionBanner
import app.argus.android.ui.components.FileChipsRow
import app.argus.android.ui.markdown.AnswerView
import app.argus.android.ui.markdown.MarkdownImageContext
import app.argus.android.ui.sessions.RenameDialog
import app.argus.android.ui.theme.argusPalette
import app.argus.core.engine.ProjectRef
import app.argus.core.engine.QueuedPrompt
import app.argus.core.engine.Turn
import kotlinx.coroutines.launch

/**
 * One session: the streaming transcript above the composer. Port of the
 * Phase 2 slice of SessionView.swift — the inspector, model picker,
 * attachments and fork arrive in Phase 3.
 */
@Composable
fun SessionScreen(app: AppModel, sessionId: String, onBack: () -> Unit) {
    val sessions by app.sessionList.sessions.collectAsState()
    val projects by app.fleet.projects.collectAsState()
    val session = sessions[sessionId]
    val agentType = session?.cliType ?: "custom"
    val projectRef: ProjectRef? = remember(session?.projectId, projects) { app.fleet.projectRef(session) }
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
    val isRunning = if (model != null) model.isRunning.collectAsState().value else false

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(session?.title ?: "Session", maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (isRunning) {
                        TextButton(onClick = { scope.launch { model?.cancelRunningTurn() } }) {
                            Text("Stop", color = MaterialTheme.colorScheme.error)
                        }
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(text = { Text("Rename") }, onClick = { menuOpen = false; showRename = true })
                            if (session != null) {
                                val archived = session.archivedAt != null
                                DropdownMenuItem(
                                    text = { Text(if (archived) "Unarchive" else "Archive") },
                                    onClick = {
                                        menuOpen = false
                                        scope.launch {
                                            val client = app.client ?: return@launch
                                            try {
                                                val updated = if (archived) client.unarchiveSession(sessionId) else client.archiveSession(sessionId)
                                                app.sessionList.upsert(updated)
                                            } catch (e: Exception) {
                                                app.handleApiError(e)
                                            }
                                        }
                                    },
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
            Transcript(app = app, model = model, projectRef = projectRef, modifier = Modifier.weight(1f))
            Composer(app = app, model = model, sessionId = sessionId)
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
}

// MARK: Transcript

@Composable
private fun Transcript(app: AppModel, model: SessionViewModel, projectRef: ProjectRef?, modifier: Modifier = Modifier) {
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
    // File preview is Phase 3; citations are inert until then.
    val onOpenFile: (String, Int?) -> Unit = { _, _ -> }

    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 10.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (turn.attachments.isNotEmpty()) {
            Text(
                turn.attachments.joinToString("  ") { "📎 ${it.filename}" },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (turn.prompt.isNotEmpty()) PromptBubble(turn.prompt)
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

/** The user message — a soft bubble on surface2, clamped with tap-to-expand. */
@Composable
private fun PromptBubble(text: String) {
    var expanded by remember { mutableStateOf(false) }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(argusPalette.surface2, RoundedCornerShape(14.dp))
            .clickable { expanded = !expanded }
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = if (expanded) Int.MAX_VALUE else 6,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// MARK: Composer

/**
 * The web's rounded composer: the auto-growing field and the send /
 * add-to-queue action. Submits route through the queue (AppModel.
 * submitPrompt): joining the FIFO tail keeps manual sends from jumping a
 * draining backlog, and the drainer dispatches immediately when the
 * session is free.
 */
@Composable
private fun Composer(app: AppModel, model: SessionViewModel, sessionId: String) {
    val actionError by model.actionError.collectAsState()
    val isRunning by model.isRunning.collectAsState()
    val queueItems by app.queue.items.collectAsState()
    val queued = remember(queueItems) { queueItems.filter { it.sessionId == sessionId } }
    var draft by remember(sessionId) { mutableStateOf("") }

    // Running turn OR queued backlog → submits join the queue.
    val busy = isRunning || queued.isNotEmpty()
    val canSend = draft.isNotBlank()

    fun send() {
        if (!canSend) return
        val text = draft
        draft = ""
        app.submitPrompt(sessionId, text, emptyList())
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

        Row(verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = { Text(if (busy) "Queue a follow-up…" else "Request changes or ask a question…") },
                maxLines = 6,
                shape = RoundedCornerShape(22.dp),
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = { send() },
                enabled = canSend,
                modifier = Modifier
                    .size(44.dp)
                    .background(
                        if (canSend) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f),
                        CircleShape,
                    ),
            ) {
                Icon(
                    if (busy) Icons.Default.Add else Icons.AutoMirrored.Filled.Send,
                    contentDescription = if (busy) "Queue" else "Send",
                    tint = if (canSend) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
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
