package app.argus.android.session

import app.argus.core.api.ApiError
import app.argus.core.api.ArgusClient
import app.argus.core.engine.ContextSnapshot
import app.argus.core.engine.TranscriptState
import app.argus.core.engine.Turn
import app.argus.core.model.AgentType
import app.argus.core.model.CommandDTO
import app.argus.core.model.CommandKind
import app.argus.core.model.CreateCommandRequest
import app.argus.core.model.ResultChunk
import app.argus.core.model.SessionStatusEvent
import app.argus.core.model.TokenUsage
import app.argus.core.realtime.StreamClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Per-open-session state: the TranscriptState reducer plus room
 * membership, send/cancel, history pagination, and the reconnect /
 * foreground catch-up paths. AppModel routes live socket events here
 * while this session is on screen. Port of
 * apps/ios/Argus/Sources/SessionViewModel.swift; main-thread only.
 */
class SessionViewModel(
    val sessionId: String,
    val agentType: AgentType,
    private val client: ArgusClient,
    private val stream: StreamClient,
    private val scope: CoroutineScope,
    private val onAuthError: (Throwable) -> Unit,
) {
    sealed interface LoadState {
        data object Loading : LoadState
        data object Loaded : LoadState
        data class Failed(val message: String) : LoadState
    }

    private val _loadState = MutableStateFlow<LoadState>(LoadState.Loading)
    val loadState: StateFlow<LoadState> = _loadState.asStateFlow()

    private val _turns = MutableStateFlow<List<Turn>>(emptyList())
    val turns: StateFlow<List<Turn>> = _turns.asStateFlow()

    private val _isRunning = MutableStateFlow(false)
    val isRunning: StateFlow<Boolean> = _isRunning.asStateFlow()

    private val _hasMoreHistory = MutableStateFlow(false)
    val hasMoreHistory: StateFlow<Boolean> = _hasMoreHistory.asStateFlow()

    private val _loadingOlder = MutableStateFlow(false)
    val loadingOlder: StateFlow<Boolean> = _loadingOlder.asStateFlow()

    /** Cumulative session usage (header badge ↑/↓ totals). */
    private val _usage = MutableStateFlow<TokenUsage?>(null)
    val usage: StateFlow<TokenUsage?> = _usage.asStateFlow()

    /** Latest-turn live context vs the model window (donut ring). */
    private val _context = MutableStateFlow<ContextSnapshot?>(null)
    val context: StateFlow<ContextSnapshot?> = _context.asStateFlow()

    /** Transient send/cancel failure surfaced above the composer. */
    val actionError = MutableStateFlow<String?>(null)

    private val transcript = TranscriptState(sessionId)
    private var rebuildScheduled = false

    // MARK: Lifecycle

    /**
     * Idempotent open — runs on every appearance, cold or cached
     * (AppModel keeps view-models alive across session switches).
     * Cold: full snapshot load behind the spinner. Cached: the screen
     * renders the existing transcript immediately and this refreshes it
     * in place (stale-while-revalidate) — off-screen sessions leave their
     * WS room, so anything that streamed while away was missed.
     */
    suspend fun start() {
        stream.joinSession(sessionId)
        if (_loadState.value is LoadState.Loaded) revalidate() else reloadSnapshot()
        markSeen()
    }

    fun stop() {
        stream.leaveSession(sessionId)
    }

    private suspend fun reloadSnapshot() {
        try {
            val detail = client.getSession(sessionId, tailCommands = TAIL_WINDOW)
            transcript.applySnapshot(detail.commands, detail.chunks, detail.hasMore)
            _loadState.value = LoadState.Loaded
            rebuildNow()
        } catch (e: Exception) {
            onAuthError(e)
            if (_loadState.value is LoadState.Loading) {
                _loadState.value = LoadState.Failed((e as? ApiError)?.message ?: e.message ?: "Couldn't load")
            }
        }
    }

    /**
     * Refresh a cached transcript without blanking it. When the fresh
     * tail overlaps what we hold, MERGE it — command ids stay stable (no
     * list jump) and older pages the user scrolled in survive. A disjoint
     * window (> TAIL_WINDOW turns landed while away) would leave a gap
     * mid-transcript if merged, so that case falls back to the
     * wipe-and-replace snapshot. `hasMoreHistory` is kept on the merge
     * path: the response's flag describes its own window, while the
     * cached transcript may already reach further back.
     */
    private suspend fun revalidate() {
        try {
            val detail = client.getSession(sessionId, tailCommands = TAIL_WINDOW)
            val known = transcript.commands.map { it.id }.toSet()
            if (detail.commands.any { it.id in known }) {
                transcript.mergeBackfill(detail.commands, detail.chunks)
            } else {
                transcript.applySnapshot(detail.commands, detail.chunks, detail.hasMore)
            }
            rebuildNow()
        } catch (e: Exception) {
            // Keep showing the cached transcript; 401s still funnel out.
            onAuthError(e)
        }
    }

    /**
     * Socket reconnect catch-up. The chunks endpoint answers with EVERY
     * command in the session, not a window — `mergeBackfill` keeps only
     * the turns this window holds or that were created while away, so a
     * reconnect can't un-window the tail (see TranscriptState).
     */
    suspend fun handleReconnect() {
        stream.joinSession(sessionId)
        try {
            val missed = client.getSessionChunks(sessionId, afterSeq = transcript.maxSeq)
            transcript.mergeBackfill(missed.commands, missed.chunks)
            rebuildNow()
        } catch (e: Exception) {
            onAuthError(e)
        }
    }

    // MARK: Live ingest (called by AppModel's event pump)

    fun ingestLive(chunk: ResultChunk) {
        if (chunk.sessionId != sessionId) return
        if (transcript.append(chunk)) scheduleRebuild()
    }

    fun ingest(command: CommandDTO) {
        if (command.sessionId != sessionId) return
        transcript.upsert(command)
        scheduleRebuild()
    }

    fun handleStatus(event: SessionStatusEvent) {
        if (event.id != sessionId) return
        // The turn just finished while we're looking at it — the web
        // suppresses the unread dot in exactly this case.
        if (event.unread) markSeen()
    }

    // MARK: Actions

    /** Direct send (the composer routes through AppModel.submitPrompt / the queue instead). */
    suspend fun send(text: String) {
        val prompt = text.trim()
        if (prompt.isEmpty()) return
        actionError.value = null
        try {
            val command = client.sendCommand(sessionId, CreateCommandRequest(prompt = prompt))
            transcript.upsert(command)
            rebuildNow()
        } catch (e: Exception) {
            onAuthError(e)
            actionError.value = (e as? ApiError)?.message ?: e.message
        }
    }

    suspend fun cancelRunningTurn() {
        val running = transcript.commands.lastOrNull { it.kind == CommandKind.EXECUTE && !it.status.isTerminal }
            ?: return
        try {
            val command = client.cancelCommand(running.id)
            transcript.upsert(command)
            rebuildNow()
        } catch (e: Exception) {
            onAuthError(e)
            actionError.value = (e as? ApiError)?.message ?: e.message
        }
    }

    suspend fun loadOlder() {
        if (!_hasMoreHistory.value || _loadingOlder.value) return
        val before = transcript.oldestCommandId ?: return
        _loadingOlder.value = true
        try {
            val page = client.getSessionHistory(sessionId, beforeCommandId = before)
            transcript.mergeOlder(page.commands, page.chunks, page.hasMore)
            rebuildNow()
        } catch (e: Exception) {
            onAuthError(e)
        } finally {
            _loadingOlder.value = false
        }
    }

    private fun markSeen() {
        scope.launch {
            runCatching { client.markSessionSeen(sessionId) }
        }
    }

    // MARK: Turn derivation

    /**
     * Deltas arrive many times per second; rebuilding (and re-parsing
     * markdown) per chunk wastes main-thread time. Coalesce to ~12 Hz.
     */
    private fun scheduleRebuild() {
        if (rebuildScheduled) return
        rebuildScheduled = true
        scope.launch {
            delay(REBUILD_COALESCE_MS)
            rebuildScheduled = false
            rebuildNow()
        }
    }

    private fun rebuildNow() {
        _turns.value = transcript.turns(agentType)
        _isRunning.value = transcript.isRunning
        _hasMoreHistory.value = transcript.hasMoreHistory
        _usage.value = transcript.totalUsage(agentType)
        _context.value = transcript.contextSnapshot(agentType)
    }

    companion object {
        /**
         * Initial-load page size — matches the web's DEFAULT_TAIL.
         * Deliberately small: open cost scales with chunks per turn, not
         * turn count; loadOlder pages the rest in on demand.
         */
        private const val TAIL_WINDOW = 4
        private const val REBUILD_COALESCE_MS = 80L
    }
}
