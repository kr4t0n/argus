@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.palette

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.AppModel
import app.argus.android.PaletteMode
import app.argus.android.ui.components.AgentTypeGlyph
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.engine.RankedSession
import app.argus.core.engine.RelativeTime
import app.argus.core.engine.SearchSnippet
import app.argus.core.engine.SessionCandidate
import app.argus.core.engine.SessionMatch
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionSearchHitDTO
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

// The Ctrl+P / Ctrl+K / Ctrl+/ overlay — the Android counterpart of
// apps/ios/Argus/Sources/Views/CommandPalette.swift (PaletteSheet +
// CommandPaletteSheet) and the web's CommandPalette.tsx. Hotkey DISPATCH
// lives in AppModel (the activity's key path → dispatchHotkey); this file
// only renders whatever `AppModel.paletteMode` says is up.

/**
 * The ONE sheet behind [AppModel.paletteMode]. Mounted once at the app
 * root; renders nothing while the mode is null. Three overlays share a
 * single presentation so pressing another overlay's hotkey swaps the
 * content in place — two sheets would have to negotiate which of them is
 * up, and Compose would stack the second dialog over the first.
 *
 * The mode last shown is LATCHED: `paletteMode` goes null the moment the
 * sheet starts dismissing, and this content keeps rendering through the
 * dismiss animation — read the store directly and an outgoing help sheet
 * re-renders as the search palette on its way out (the iPad regression
 * `PaletteSheet` records). Only non-null modes are recorded, so whatever
 * was up stays up until the sheet is gone.
 *
 * The sheet stays in composition until it has animated out: a hotkey
 * toggle sets the mode null without touching the sheet, so the host
 * hides it itself and only then drops it — otherwise Ctrl+P twice would
 * snap the sheet away with no exit motion at all.
 */
@Composable
fun PaletteHost(app: AppModel, onOpenSession: (sessionId: String) -> Unit) {
    val mode by app.paletteMode.collectAsState()
    var shown by remember { mutableStateOf<PaletteMode?>(null) }
    var visible by remember { mutableStateOf(false) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(mode) {
        val live = mode
        if (live != null) {
            shown = live
            // Re-opened mid-dismiss (or switched mode): the sheet is still
            // composed, so bring it back rather than composing a second one.
            if (visible) sheetState.show() else visible = true
        } else if (visible) {
            sheetState.hide()
            visible = false
        }
    }

    if (!visible) return
    val effective = mode ?: shown ?: return

    ModalBottomSheet(
        onDismissRequest = { app.closePalette() },
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.9f)
                .imePadding(),
        ) {
            if (effective == PaletteMode.HELP) {
                ShortcutsHelpSheet(onDismiss = { app.closePalette() })
            } else {
                CommandPalette(app = app, mode = effective, onOpenSession = onOpenSession)
            }
        }
    }
}

/**
 * Debounce before firing a content query. Long enough that typing a word
 * is one request, short enough to feel live. Session mode has no debounce
 * — it never leaves the device.
 */
private const val CONTENT_DEBOUNCE_MS = 200L

/** The server rejects shorter; mirrored here to avoid the round-trip. */
private const val MIN_CONTENT_QUERY = 2

/** Rows shown in session mode, including the zero-query recents list. */
private const val SESSION_LIMIT = 12

/** Hits requested in content mode (one per session — the server dedupes). */
private const val CONTENT_LIMIT = 20

/**
 * The Ctrl+P / Ctrl+K palette — one composable, two modes (the web's
 * CommandPalette):
 *
 *   Ctrl+P  SESSION — switch by NAME. Ranked client-side by `SessionMatch`
 *                     over the session list the app already holds, so it
 *                     is instant and needs no API. An EMPTY query lists
 *                     recent live sessions (the ranker's own rule), which
 *                     makes switching two keystrokes.
 *   Ctrl+K  CONTENT — search what was SAID. Server-side full text over
 *                     prompts and answers, archived included, snippets
 *                     highlighted.
 *
 * Tab switches mode and KEEPS the query — the whole point is re-running
 * the same words against the other index; the chips below the field are
 * the touch path to the same switch. Selecting a row navigates and
 * closes. A Ctrl+K hit opens the session at its TAIL: the web lands on
 * the matched turn through a floating transcript window, which this
 * client's transcript engine does not model yet (see AGENTS.md).
 *
 * [mode] is handed in by [PaletteHost] rather than read from the store,
 * for the same reason the host latches it: the store is null while the
 * sheet dismisses, and a Ctrl+K page would otherwise snap to Ctrl+P rows
 * during the animation.
 */
@Composable
private fun ColumnScope.CommandPalette(
    app: AppModel,
    mode: PaletteMode,
    onOpenSession: (sessionId: String) -> Unit,
) {
    val sessionMode = mode != PaletteMode.CONTENT
    val sessions by app.sessionList.sessions.collectAsState()
    val projects by app.fleet.projects.collectAsState()
    val machines by app.fleet.machines.collectAsState()
    val client = app.client

    var query by remember { mutableStateOf("") }
    var cursor by remember { mutableStateOf(0) }
    var hits by remember { mutableStateOf<List<SessionSearchHitDTO>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var searchError by remember { mutableStateOf<String?>(null) }
    val focusRequester = remember { FocusRequester() }
    val listState = rememberLazyListState()

    val trimmedQuery = query.trim()
    // Candidate labels resolve through the fleet stores, so they are
    // rebuilt only when a store changes — not on every keystroke.
    val candidates: List<SessionCandidate> = remember(sessions, projects, machines) {
        app.sessionList.searchCandidates(app.fleet)
    }
    val ranked: List<RankedSession> = remember(sessionMode, query, candidates) {
        if (sessionMode) SessionMatch.rank(query, candidates, SESSION_LIMIT) else emptyList()
    }
    // Rows are keyed by session id in both modes, so navigation and the
    // keyboard cursor are written once.
    val ids: List<String> = if (sessionMode) ranked.map { it.id } else hits.map { it.sessionId }
    // Ranking is synchronous, so the cursor can outlive a shrinking list.
    val activeIndex = if (ids.isEmpty()) 0 else cursor.coerceIn(0, ids.lastIndex)

    fun moveCursor(delta: Int) {
        if (ids.isEmpty()) return
        cursor = (activeIndex + delta).coerceIn(0, ids.lastIndex)
    }

    fun switchMode() {
        app.openPalette(if (sessionMode) PaletteMode.CONTENT else PaletteMode.SESSION)
    }

    fun openRow(index: Int) {
        val sessionId = ids.getOrNull(index) ?: return
        onOpenSession(sessionId)
        app.closePalette()
    }

    // Focus once the sheet is in its window — the effect runs after the
    // field's node is attached (what requestFocus needs), and the short
    // wait covers the dialog window taking focus, without which the
    // request can be dropped silently (the iOS sheet waits the same way).
    LaunchedEffect(Unit) {
        delay(50)
        focusRequester.requestFocus()
    }

    // Mode switch: same words, other index; the cursor restarts at the top.
    LaunchedEffect(mode) { cursor = 0 }

    // Content mode: debounced server query. Keying the effect on the
    // query is what cancels the previous request — a slow early response
    // can never resolve after a fast later one and overwrite good results
    // (the web's AbortController). `loading` is deliberately NOT cleared
    // in a `finally`: a cancelled effect must not race the next one's
    // `loading = true`, so only a settled request touches it.
    LaunchedEffect(sessionMode, trimmedQuery, client) {
        if (sessionMode || client == null || trimmedQuery.length < MIN_CONTENT_QUERY) {
            hits = emptyList()
            loading = false
            searchError = null
            return@LaunchedEffect
        }
        loading = true
        searchError = null
        delay(CONTENT_DEBOUNCE_MS)
        try {
            val response = client.searchSessions(trimmedQuery, limit = CONTENT_LIMIT)
            hits = response.hits
            cursor = 0
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Failed — leave the previous page up; 401s still funnel to
            // the login screen.
            app.handleApiError(e)
            searchError = (e as? ApiError)?.message ?: e.message ?: "Search failed"
        }
        loading = false
    }

    // Keep the keyboard cursor inside the viewport. Index-based, so the
    // list needs no lookup by key; a move past the bottom edge pulls the
    // list up by one viewport-height's worth of rows (approximate — rows
    // are near-uniform) instead of snapping the target to the top.
    LaunchedEffect(activeIndex, ids.size) {
        if (ids.isEmpty()) return@LaunchedEffect
        val info = listState.layoutInfo
        val first = info.visibleItemsInfo.firstOrNull()?.index ?: return@LaunchedEffect
        val last = info.visibleItemsInfo.lastOrNull()?.index ?: first
        when {
            activeIndex < first -> listState.animateScrollToItem(activeIndex)
            activeIndex >= last -> listState.animateScrollToItem((activeIndex - (last - first)).coerceAtLeast(0))
        }
    }

    val secondary = MaterialTheme.colorScheme.onSurfaceVariant

    // Header: title + Cancel (the sheet's scrim and swipe also dismiss).
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (sessionMode) "Switch session" else "Search transcripts",
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = { app.closePalette() }) { Text("Cancel") }
    }

    // The touch path to the other index (Tab on a keyboard).
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterChip(
            selected = sessionMode,
            onClick = { if (!sessionMode) switchMode() },
            label = { Text("Sessions") },
        )
        FilterChip(
            selected = !sessionMode,
            onClick = { if (sessionMode) switchMode() },
            label = { Text("Transcripts") },
        )
    }

    OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        placeholder = {
            Text(if (sessionMode) "Switch to session…" else "Search what was said in all sessions…")
        },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = {
            if (loading) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            imeAction = ImeAction.Go,
        ),
        keyboardActions = KeyboardActions(onGo = { openRow(activeIndex) }),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .focusRequester(focusRequester)
            // Preview phase, so the arrows / Tab / Enter never reach the
            // field's own handling (Tab would move focus, Enter would be
            // swallowed by the single-line field).
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (event.key) {
                    Key.DirectionDown -> { moveCursor(1); true }
                    Key.DirectionUp -> { moveCursor(-1); true }
                    Key.Tab -> { switchMode(); true }
                    Key.Enter, Key.NumPadEnter -> { openRow(activeIndex); true }
                    Key.Escape -> { app.closePalette(); true }
                    else -> false
                }
            },
    )
    HorizontalDivider()

    searchError?.let {
        Text(
            it,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
    }

    val tooShort = !sessionMode && trimmedQuery.length < MIN_CONTENT_QUERY
    val empty = !loading && !tooShort && ids.isEmpty()

    LazyColumn(state = listState, modifier = Modifier.fillMaxWidth().weight(1f)) {
        if (sessionMode) {
            itemsIndexed(ranked, key = { _, row -> row.id }) { index, row ->
                SessionPaletteRow(
                    row = row,
                    active = index == activeIndex,
                    modifier = Modifier.clickable { openRow(index) },
                )
            }
        } else {
            itemsIndexed(hits, key = { _, hit -> hit.sessionId }) { index, hit ->
                val session = sessions[hit.sessionId]
                ContentPaletteRow(
                    hit = hit,
                    session = session,
                    origin = session?.let { paletteOrigin(app.sessionList.searchCandidate(it, app.fleet)) },
                    active = index == activeIndex,
                    modifier = Modifier.clickable { openRow(index) },
                )
            }
        }
        if (tooShort) {
            item(key = "placeholder-short") { Placeholder("Search prompts and answers across every session.") }
        } else if (empty) {
            item(key = "placeholder-empty") {
                Placeholder(if (trimmedQuery.isEmpty()) "No sessions yet." else "No matches for “$trimmedQuery”")
            }
        }
    }

    // Keyboard hints only where a keyboard is plausible: the
    // configuration reports an attached hardware keyboard that isn't
    // folded away. Cheap, and it updates with the configuration.
    val configuration = LocalConfiguration.current
    val hardwareKeyboard = configuration.keyboard == Configuration.KEYBOARD_QWERTY &&
        configuration.hardKeyboardHidden != Configuration.HARDKEYBOARDHIDDEN_YES
    if (hardwareKeyboard) {
        HorizontalDivider()
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (sessionMode) {
                    "↑↓ navigate · ⏎ open · tab search content · esc close"
                } else {
                    "↑↓ navigate · ⏎ open · tab switch session · esc close"
                },
                style = MaterialTheme.typography.labelSmall,
                color = secondary,
                modifier = Modifier.weight(1f),
            )
            if (ids.isNotEmpty()) {
                Text(
                    "${ids.size} " + (if (sessionMode) "sessions" else "matches"),
                    style = MaterialTheme.typography.labelSmall,
                    color = secondary,
                )
            }
        }
    }
}

/**
 * "project · machine" for a row's trailing label; null when neither
 * resolves (a workdir-less session, or a project row not yet hydrated).
 */
private fun paletteOrigin(candidate: SessionCandidate): String? {
    val parts = listOfNotNull(candidate.projectLabel, candidate.machineName).filter { it.isNotEmpty() }
    return if (parts.isEmpty()) null else parts.joinToString(" · ")
}

@Composable
private fun Placeholder(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 24.dp),
    )
}

/** Ctrl+P row: what the session is called and where it lives. */
@Composable
private fun SessionPaletteRow(row: RankedSession, active: Boolean, modifier: Modifier = Modifier) {
    val session = row.session
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(if (active) argusPalette.surface2 else Color.Transparent)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentTypeGlyph(session.cliType ?: "custom", size = 14)
        // The title is the only weighted child: unweighted siblings are
        // measured first and take what they need (the origin capped), so
        // the title gets every remaining pixel before it ellipsizes.
        Text(
            session.title,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (session.archivedAt != null) ArchivedTag()
        paletteOrigin(row.candidate)?.let { origin ->
            Text(
                origin,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 140.dp),
            )
        }
        Text(
            RelativeTime.short(session.updatedAt),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Ctrl+K row: the session plus why it matched. */
@Composable
private fun ContentPaletteRow(
    hit: SessionSearchHitDTO,
    session: SessionDTO?,
    origin: String?,
    active: Boolean,
    modifier: Modifier = Modifier,
) {
    val highlight = argusPalette.toolAmber.copy(alpha = 0.3f)
    val onSurface = MaterialTheme.colorScheme.onSurface
    val snippet = remember(hit.snippet, highlight, onSurface) { snippetText(hit.snippet, highlight, onSurface) }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(if (active) argusPalette.surface2 else Color.Transparent)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            session?.cliType?.let { AgentTypeGlyph(it, size = 14) }
            // A hit whose session hasn't hydrated yet (or was deleted
            // under us) still gets a row — the snippet is the useful
            // part, and dropping it would under-report the count.
            Text(
                session?.title ?: "Untitled session",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (session?.archivedAt != null) ArchivedTag()
            if (hit.matchCount > 1) {
                Text(
                    "${hit.matchCount} matches",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            snippet,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        origin?.let {
            Text(
                it,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * The server's `[[hl]]`-marked snippet as one annotated string. Built
 * from `SearchSnippet.runs` so transcript text is only ever native text
 * runs — never an HTML sink, never a markup parser.
 */
private fun snippetText(raw: String, highlight: Color, onSurface: Color): AnnotatedString =
    buildAnnotatedString {
        for (run in SearchSnippet.runs(raw)) {
            if (run.highlighted) {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, background = highlight, color = onSurface)) {
                    append(run.text)
                }
            } else {
                append(run.text)
            }
        }
    }

@Composable
private fun ArchivedTag() {
    Text(
        "ARCHIVED",
        fontSize = 9.sp,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .background(argusPalette.surface2, RoundedCornerShape(3.dp))
            .padding(horizontal = 4.dp, vertical = 1.dp),
    )
}
