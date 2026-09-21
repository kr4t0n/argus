package app.argus.android

import android.content.SharedPreferences
import app.argus.android.session.SessionViewModel
import app.argus.android.store.FleetStore
import app.argus.android.store.QueueStore
import app.argus.android.store.SessionListStore
import app.argus.core.api.ApiError
import app.argus.core.api.ArgusClient
import app.argus.core.api.ServerConfig
import app.argus.core.model.AgentType
import app.argus.core.model.AuthUser
import app.argus.core.model.CreateCommandRequest
import app.argus.core.model.MachineStatus
import app.argus.core.model.SessionStatus
import app.argus.core.model.UserExtensions
import app.argus.core.realtime.ServerEvent
import app.argus.core.realtime.StreamClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope

/**
 * App-level state: server config, auth, the socket, and event routing —
 * the Android counterpart of apps/ios/Argus/Sources/AppModel.swift.
 *
 * The JWT lives in memory here (a `@Volatile` field the OkHttp token
 * provider reads from its own threads); SharedPreferences only persists
 * it across launches. Any 401 anywhere funnels through [handleApiError]
 * and drops the app back to the login screen.
 *
 * Everything here runs on the main thread: [scope] uses
 * `Dispatchers.Main.immediate`, the socket's events are pumped onto it,
 * and the REST client resumes its callers on it. Stores expose
 * `StateFlow`s that Compose collects.
 */
class AppModel(private val prefs: SharedPreferences) {
    sealed interface Phase {
        data object Launching : Phase
        data object LoggedOut : Phase
        data object Ready : Phase
    }

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _phase = MutableStateFlow<Phase>(Phase.Launching)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    private val _user = MutableStateFlow<AuthUser?>(null)
    val user: StateFlow<AuthUser?> = _user.asStateFlow()

    private val _socketConnected = MutableStateFlow(false)
    val socketConnected: StateFlow<Boolean> = _socketConnected.asStateFlow()

    /** What the main surface shows — null is the session list. */
    private val _route = MutableStateFlow<Route?>(null)
    val route: StateFlow<Route?> = _route.asStateFlow()

    /**
     * Failed session-clone-from-turn toasts, keyed by sessionId (one per
     * session, latest wins) — web cloneFailureStore parity.
     */
    private val _cloneFailures = MutableStateFlow<List<CloneFailure>>(emptyList())
    val cloneFailures: StateFlow<List<CloneFailure>> = _cloneFailures.asStateFlow()

    /** Account-level extension opt-ins (gate the inspector's Note / Diff tabs, Phase 3). */
    private val _extensions = MutableStateFlow(UserExtensions())
    val extensions: StateFlow<UserExtensions> = _extensions.asStateFlow()

    var serverConfig: ServerConfig? = null
        private set
    var client: ArgusClient? = null
        private set
    var stream: StreamClient? = null
        private set

    val fleet = FleetStore()
    val sessionList = SessionListStore()
    val queue = QueueStore(prefs)

    /**
     * The session view currently on screen — chunk/command events are
     * routed here. Set by SessionScreen on appear/disappear.
     */
    var activeSession: SessionViewModel? = null

    /**
     * Transcript cache: view-models outlive their screens so switching
     * back to a recent session renders instantly from memory instead of
     * refetching behind a spinner. Stale-while-revalidate — the cached
     * transcript shows immediately and `SessionViewModel.start()`
     * refreshes the tail on every open (off-screen sessions leave their
     * WS room, so a cached transcript is always suspect). LRU-capped;
     * cleared on logout. Insertion order IS the LRU order (touch =
     * remove + re-put).
     */
    private val sessionVMs = LinkedHashMap<String, SessionViewModel>()

    /**
     * Per-session drain guards (mirror the web's queueDrainer): an
     * in-flight mark bridges the dispatch→first-chunk window so the same
     * session can never get two concurrent turns; a cooldown keeps a hard
     * failure from hot-looping.
     */
    private val drainInFlight = HashMap<String, Long>()
    private val drainCooldown = HashMap<String, Long>()

    /** Readable from any thread — OkHttp calls the token provider off-main. */
    @Volatile
    private var token: String? = null
    private var eventPump: Job? = null

    val savedEmail: String
        get() = prefs.getString(KEY_EMAIL, "") ?: ""
    val savedServer: String
        get() = prefs.getString(KEY_SERVER, "") ?: ""

    fun navigate(route: Route?) {
        _route.value = route
    }

    // MARK: Lifecycle

    suspend fun bootstrap() {
        if (_phase.value != Phase.Launching) return
        val raw = prefs.getString(KEY_SERVER, null)
        val config = raw?.let { ServerConfig.parse(it) }
        val stored = prefs.getString(KEY_TOKEN, null)
        if (config == null || stored.isNullOrEmpty()) {
            _phase.value = Phase.LoggedOut
            return
        }
        serverConfig = config
        token = stored
        val client = makeClient(config)
        this.client = client
        try {
            _user.value = client.me()
            _phase.value = Phase.Ready
            connectSocket()
            refreshAll()
        } catch (e: Exception) {
            // Expired/revoked token or unreachable server → login screen
            // (which prefills the saved server + email).
            prefs.edit().remove(KEY_TOKEN).apply()
            token = null
            this.client = null
            _phase.value = Phase.LoggedOut
        }
    }

    /** Throws [ApiError] (or an IOException from the transport) on failure. */
    suspend fun logIn(server: String, email: String, password: String) {
        val config = ServerConfig.parse(server)
            ?: throw ApiError(0, "Enter a valid server URL, e.g. argus.example.com:4000")
        val client = makeClient(config)
        val response = client.login(email, password)

        serverConfig = config
        token = response.token
        _user.value = response.user
        this.client = client
        prefs.edit()
            .putString(KEY_TOKEN, response.token)
            .putString(KEY_SERVER, server)
            .putString(KEY_EMAIL, email)
            .apply()

        _phase.value = Phase.Ready
        connectSocket()
        refreshAll()
    }

    fun logOut() {
        prefs.edit().remove(KEY_TOKEN).apply()
        eventPump?.cancel()
        eventPump = null
        stream?.shutdown()
        stream = null
        _socketConnected.value = false
        token = null
        _user.value = null
        client = null
        activeSession = null
        sessionVMs.clear()
        _route.value = null
        drainInFlight.clear()
        drainCooldown.clear()
        _cloneFailures.value = emptyList()
        _extensions.value = UserExtensions()
        fleet.reset()
        sessionList.reset()
        _phase.value = Phase.LoggedOut
    }

    fun handleForeground() {
        if (_phase.value != Phase.Ready) return
        scope.launch {
            refreshAll()
            // start(), not a cold reload: a loaded transcript is
            // revalidated in place instead of blanked and refetched, so
            // foregrounding doesn't reset the user's scroll position.
            activeSession?.start()
        }
    }

    /** Central 401 funnel — call from any store/screen catch block. */
    fun handleApiError(error: Throwable) {
        if (error is ApiError && error.isUnauthorized) logOut()
    }

    // MARK: Session view-model cache

    /**
     * Cached-or-new view-model for a session. Reuses the cached one when
     * present so its transcript renders instantly; the caller still runs
     * `start()`, which revalidates a cached transcript. Null before the
     * client/socket exist (mid-login teardown).
     *
     * `agentType` keys the usage/context parsers and is frozen at VM
     * init, so a cached VM built while the fleet list was still loading
     * (type fell back to "custom") is REPLACED once the real type is
     * known. The reverse (cached real type, caller passes the "custom"
     * fallback) keeps the cached VM: it knows more than the caller.
     */
    fun sessionViewModel(sessionId: String, agentType: AgentType): SessionViewModel? {
        val client = client ?: return null
        val stream = stream ?: return null
        val cached = sessionVMs[sessionId]
        if (cached != null && (cached.agentType == agentType || agentType == "custom")) {
            sessionVMs.remove(sessionId)
            sessionVMs[sessionId] = cached
            return cached
        }
        val vm = SessionViewModel(
            sessionId = sessionId,
            agentType = agentType,
            client = client,
            stream = stream,
            scope = scope,
            onAuthError = ::handleApiError,
        )
        sessionVMs.remove(sessionId)
        sessionVMs[sessionId] = vm
        evictSessionVMs()
        return vm
    }

    private fun evictSessionVMs() {
        while (sessionVMs.size > SESSION_VM_CACHE_LIMIT) {
            // Never evict the session on screen — live chunks route to it.
            val victim = sessionVMs.keys.firstOrNull { sessionVMs[it] !== activeSession } ?: return
            sessionVMs.remove(victim)
        }
    }

    // MARK: Data

    suspend fun refreshAll() {
        val client = client ?: return
        // Each list applies independently so one transient failure can't
        // abort the rest; 401s funnel through handleApiError. Archived
        // sessions are included so they stay reachable via the
        // per-project eye toggle.
        supervisorScope {
            val machines = async { client.listMachines() }
            val projects = async { client.listProjects() }
            val sessions = async { client.listSessions(includeArchived = true) }
            val extensions = async { client.getMyExtensions() }
            runCatching { fleet.setMachines(machines.await()) }.onFailure(::handleApiError)
            runCatching { fleet.setProjects(projects.await()) }.onFailure(::handleApiError)
            runCatching { sessionList.setAll(sessions.await()) }.onFailure(::handleApiError)
            runCatching { _extensions.value = extensions.await() }.onFailure(::handleApiError)
        }
        maybeDrainAllQueues()
    }

    // MARK: Prompt queue drainer

    /**
     * Route a composer submit through the queue: joining the FIFO tail
     * keeps manual sends from jumping a draining backlog, and the drainer
     * dispatches immediately when the session is free — so the idle case
     * still feels like a direct send.
     */
    fun submitPrompt(sessionId: String, text: String, attachmentIds: List<String>) {
        queue.enqueue(sessionId, text, attachmentIds)
        maybeDrain(sessionId)
    }

    fun maybeDrainAllQueues() {
        for (sessionId in queue.items.value.map { it.sessionId }.toSet()) maybeDrain(sessionId)
    }

    private fun maybeDrain(sessionId: String) {
        val client = client ?: return
        val head = queue.head(sessionId) ?: return
        // Unknown session yet (lists still loading) → retry on refresh.
        val session = sessionList.sessions.value[sessionId] ?: return
        // The ONE invariant: never two turns for the same session.
        if (session.status == SessionStatus.ACTIVE) return
        val now = System.currentTimeMillis()
        drainInFlight[sessionId]?.let { if (now - it < DRAIN_IN_FLIGHT_MS) return }
        drainCooldown[sessionId]?.let { if (now < it) return }
        // Reachability is MACHINE-level: liveness belongs to the sidecar
        // process. A session with no resolvable machine (workdir-less, or
        // Project row not hydrated yet) is left drainable rather than
        // blocked. Busy stays per-session, never per-agent.
        fleet.projectRef(session)?.machineId?.let { machineId ->
            if (fleet.machines.value[machineId]?.status != MachineStatus.ONLINE) return
        }

        drainInFlight[sessionId] = now
        scope.launch {
            try {
                val command = client.sendCommand(
                    sessionId,
                    CreateCommandRequest(
                        prompt = head.text,
                        attachmentIds = head.attachmentIds.ifEmpty { null },
                    ),
                )
                queue.remove(head.id)
                activeSession?.ingest(command)
                // drainInFlight stays set until the session goes active
                // (or the bridge expires) — that's the guard window.
            } catch (e: Exception) {
                drainInFlight.remove(sessionId)
                drainCooldown[sessionId] = System.currentTimeMillis() + DRAIN_COOLDOWN_MS
                handleApiError(e)
                if (activeSession?.sessionId == sessionId) {
                    activeSession?.actionError?.value = (e as? ApiError)?.message ?: e.message
                }
            }
        }
    }

    // MARK: Socket

    private fun makeClient(config: ServerConfig): ArgusClient =
        ArgusClient(config.baseUrl, tokenProvider = { token })

    private fun connectSocket() {
        val config = serverConfig ?: return
        val token = token ?: return
        eventPump?.cancel()
        stream?.shutdown()
        val stream = StreamClient()
        this.stream = stream
        stream.connect(config.baseUrl, token)
        eventPump = scope.launch {
            stream.events.collect { event -> handle(event) }
        }
    }

    private fun handle(event: ServerEvent) {
        when (event) {
            ServerEvent.Connected -> {
                _socketConnected.value = true
                // Socket.IO rooms don't survive reconnects; delivery has no
                // replay. Rejoin + backfill, and refresh the lists we may
                // have missed events for. StreamClient refcounts project
                // rooms, so it can replay exactly what's held.
                stream?.rejoinProjectRooms()
                scope.launch {
                    refreshAll()
                    activeSession?.handleReconnect()
                }
            }
            ServerEvent.Disconnected -> _socketConnected.value = false
            is ServerEvent.SocketError -> {}

            is ServerEvent.Chunk -> activeSession?.ingestLive(event.chunk)
            is ServerEvent.CommandCreated -> activeSession?.ingest(event.command)
            is ServerEvent.CommandUpdated -> activeSession?.ingest(event.command)

            is ServerEvent.SessionCreated -> sessionList.upsert(event.session)
            is ServerEvent.SessionUpdated -> sessionList.upsert(event.session)
            is ServerEvent.SessionStatusChanged -> {
                val status = event.event
                sessionList.applyStatus(status)
                activeSession?.handleStatus(status)
                if (status.status == SessionStatus.ACTIVE) {
                    // Dispatch→active bridge closed; the queue stays parked
                    // until this turn finishes.
                    drainInFlight.remove(status.id)
                } else {
                    maybeDrain(status.id)
                }
            }
            is ServerEvent.SessionCloneFailed -> {
                // Look the session up at push time so the toast shows the
                // human title even if the row hasn't hydrated yet; fall back
                // to the id prefix so the label is never empty.
                val payload = event.payload
                val title = sessionList.sessions.value[payload.sessionId]?.title ?: payload.sessionId.take(8)
                _cloneFailures.value = _cloneFailures.value.filter { it.sessionId != payload.sessionId } +
                    CloneFailure(payload.sessionId, title, payload.reason, System.currentTimeMillis())
            }

            is ServerEvent.MachineUpsert -> fleet.upsert(event.machine)
            is ServerEvent.MachineStatusChanged -> fleet.applyMachineStatus(event.payload)
            is ServerEvent.MachineRemoved -> fleet.removeMachine(event.payload.id)
            is ServerEvent.ProjectUpsert -> fleet.upsert(event.project)

            // Inspector panels (Phase 3) will watch these.
            is ServerEvent.FsChanged, is ServerEvent.GitChanged -> {}
            is ServerEvent.TerminalCreated, is ServerEvent.TerminalUpdated,
            is ServerEvent.TerminalOutput, is ServerEvent.TerminalClosed -> {}
        }
    }

    fun dismissCloneFailure(sessionId: String) {
        _cloneFailures.value = _cloneFailures.value.filter { it.sessionId != sessionId }
    }

    companion object {
        private const val KEY_SERVER = "argus.serverURL"
        private const val KEY_EMAIL = "argus.email"
        private const val KEY_TOKEN = "argus.token"
        private const val SESSION_VM_CACHE_LIMIT = 8
        private const val DRAIN_IN_FLIGHT_MS = 30_000L
        private const val DRAIN_COOLDOWN_MS = 60_000L
    }
}

/** What the main surface shows; null is the session list. */
sealed interface Route {
    data class Session(val id: String) : Route
}

/**
 * The fork itself succeeded (the Session row exists); what failed is
 * cloning the CLI's on-disk state, so the copy says the next prompt
 * starts a fresh conversation. `startedAt` participates in the id so a
 * re-failure of the same session gets fresh identity — and a fresh timer.
 */
data class CloneFailure(
    val sessionId: String,
    val sessionTitle: String,
    val reason: String,
    val startedAt: Long,
) {
    val id: String get() = "$sessionId-$startedAt"
}
