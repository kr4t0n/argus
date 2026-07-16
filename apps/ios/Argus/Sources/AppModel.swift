import Foundation
import Observation
import ArgusKit

/// App-level state: server config, auth, the socket, and event routing.
///
/// The JWT lives in memory here; `TokenStore` (Keychain) only persists it
/// across launches. Any 401 anywhere funnels through `handleAPIError` and
/// drops the app back to the login screen.
@MainActor
@Observable
final class AppModel {
    enum Phase {
        case launching
        case loggedOut
        case ready
    }

    private(set) var phase: Phase = .launching
    private(set) var serverConfig: ServerConfig?
    private(set) var user: AuthUser?
    private(set) var client: ArgusClient?
    private(set) var stream: StreamClient?
    private(set) var socketConnected = false

    /// Split-view detail route — settable from anywhere (sidebar taps,
    /// fork navigation, creation flows). Mirrors the web's routes:
    /// /sessions/:id, /machines/:id, /user.
    var route: DetailRoute?
    /// Right inspector (Files / Commits / Diff) visibility.
    var inspectorPresented = false

    var selectedSessionId: String? {
        if case .session(let id) = route { return id }
        return nil
    }

    /// Latest fs/git change events — inspector panels watch these and
    /// refetch when the event matches their project's
    /// (machineId, workingDir) pair.
    private(set) var lastFSChange: FSChangedPayload?
    private(set) var lastGitChange: GitChangedPayload?

    /// Latest background-task events (Progress extension) — the pane
    /// watches these while subscribed to its project room.
    private(set) var lastBackgroundTaskUpdate: BackgroundTaskDTO?
    private(set) var lastBackgroundTaskRemoval: BackgroundTaskRemovedPayload?

    /// Account-level extension opt-ins — gate the inspector's Note /
    /// Progress / Diff tabs, exactly like the web's ContextPane.
    private(set) var extensions = UserExtensions()

    /// Task-completion push notifications (device-local preference; the
    /// permission prompt fires on first enable).
    private(set) var pushEnabled = UserDefaults.standard.bool(forKey: pushEnabledKey)
    private static let pushEnabledKey = "argus.push.enabled"
    private static let pushTokenKey = "argus.push.token"

    let fleet = FleetStore()
    let sessionList = SessionListStore()
    let queue = QueueStore()

    /// Per-session drain guards (mirror the web's queueDrainer): an
    /// in-flight mark bridges the dispatch→first-chunk window so the
    /// same session can never get two concurrent turns; a cooldown keeps
    /// a hard failure from hot-looping.
    @ObservationIgnored private var drainInFlight: [String: Date] = [:]
    @ObservationIgnored private var drainCooldown: [String: Date] = [:]

    /// The session view currently on screen — chunk/command events are
    /// routed here. Set by SessionView on appear/disappear.
    @ObservationIgnored weak var activeSession: SessionViewModel?

    /// Transcript cache: view-models outlive their views so switching
    /// back to a recent session renders instantly from memory instead
    /// of refetching behind a spinner. Stale-while-revalidate — the
    /// cached transcript shows immediately and `SessionViewModel.start()`
    /// refreshes the tail on every open (off-screen sessions leave their
    /// WS room, so a cached transcript is always suspect). LRU-capped;
    /// cleared on logout.
    @ObservationIgnored private var sessionVMs: [String: SessionViewModel] = [:]
    /// LRU order for the cache above, most recently opened last.
    @ObservationIgnored private var sessionVMOrder: [String] = []
    private static let sessionVMCacheLimit = 8

    /// The inspector's live PTY (if any) — terminal events route here.
    @ObservationIgnored weak var activeTerminal: TerminalController?

    /// The JWT, readable from any thread — URLSession calls the token
    /// provider off the main actor, so this cannot be a MainActor
    /// property.
    private let tokenBox = TokenBox()
    private var eventPump: Task<Void, Never>?

    private static let serverDefaultsKey = "argus.serverURL"
    private static let emailDefaultsKey = "argus.email"

    var savedEmail: String {
        UserDefaults.standard.string(forKey: Self.emailDefaultsKey) ?? ""
    }

    var savedServer: String {
        UserDefaults.standard.string(forKey: Self.serverDefaultsKey) ?? ""
    }

    // MARK: Lifecycle

    func bootstrap() async {
        guard phase == .launching else { return }
        guard
            let raw = UserDefaults.standard.string(forKey: Self.serverDefaultsKey),
            let config = ServerConfig.parse(raw),
            let stored = TokenStore.read(server: config.displayName)
        else {
            phase = .loggedOut
            return
        }

        serverConfig = config
        tokenBox.set(stored)
        let client = makeClient(config: config)
        self.client = client
        do {
            user = try await client.me()
            phase = .ready
            connectSocket()
            setUpPush()
            await refreshAll()
        } catch {
            // Expired/revoked token or unreachable server → login screen
            // (which prefills the saved server + email).
            TokenStore.clear(server: config.displayName)
            tokenBox.set(nil)
            self.client = nil
            phase = .loggedOut
        }
    }

    func logIn(server: String, email: String, password: String) async throws {
        guard let config = ServerConfig.parse(server) else {
            throw APIError(status: 0, message: "Enter a valid server URL, e.g. argus.example.com:4000")
        }
        let client = makeClient(config: config)
        let response = try await client.login(email: email, password: password)

        serverConfig = config
        tokenBox.set(response.token)
        user = response.user
        self.client = client
        TokenStore.save(response.token, server: config.displayName)
        UserDefaults.standard.set(server, forKey: Self.serverDefaultsKey)
        UserDefaults.standard.set(email, forKey: Self.emailDefaultsKey)

        phase = .ready
        connectSocket()
        setUpPush()
        await refreshAll()
    }

    func logOut() {
        LiveActivityManager.shared.endAll()
        unregisterDeviceForLogout()
        if let config = serverConfig {
            TokenStore.clear(server: config.displayName)
        }
        eventPump?.cancel()
        eventPump = nil
        stream?.shutdown()
        stream = nil
        socketConnected = false
        tokenBox.set(nil)
        user = nil
        client = nil
        activeSession = nil
        sessionVMs = [:]
        sessionVMOrder = []
        route = nil
        inspectorPresented = false
        drainInFlight = [:]
        drainCooldown = [:]
        extensions = UserExtensions()
        fleet.reset()
        sessionList.reset()
        phase = .loggedOut
    }

    func handleForeground() {
        guard phase == .ready else { return }
        Task {
            await refreshAll()
            // start(), not reloadSnapshot(): a loaded transcript is
            // revalidated in place instead of blanked and refetched, so
            // foregrounding doesn't reset the user's scroll position.
            await activeSession?.start()
            // Adopt/resolve any lock-screen cards that outlived their
            // turn (the server's end push handles this when APNs is
            // configured; this is the fallback).
            LiveActivityManager.shared.reconcile { [weak self] sessionId in
                self?.sessionList.sessions[sessionId]?.status
            }
        }
    }

    // MARK: Push notifications

    /// Wire PushManager and (when previously enabled) refresh this
    /// device's registration. Called whenever the app reaches `.ready`.
    private func setUpPush() {
        PushManager.shared.onDeviceToken = { [weak self] token in
            guard let self, let client = self.client else { return }
            UserDefaults.standard.set(token, forKey: Self.pushTokenKey)
            Task {
                do {
                    try await client.registerDevice(token: token)
                } catch {
                    self.handleAPIError(error)
                }
            }
        }
        PushManager.shared.onOpenSession = { [weak self] sessionId in
            self?.route = .session(sessionId)
        }
        // Web behavior: never notify about the session already on screen.
        PushManager.shared.shouldSuppress = { [weak self] sessionId in
            self?.activeSession?.sessionId == sessionId
        }
        if pushEnabled {
            // Permission was granted before; re-registering refreshes a
            // possibly-rotated APNs token (registration is idempotent).
            Task { _ = await PushManager.shared.requestAndRegister() }
        }

        // Live Activities: stream each activity's push token to the
        // server so it can drive the lock-screen card while we're
        // backgrounded.
        LiveActivityManager.shared.register = { [weak self] sessionId, tokenHex in
            guard let client = self?.client else { return }
            try? await client.registerLiveActivity(token: tokenHex, sessionId: sessionId)
        }
        LiveActivityManager.shared.unregister = { [weak self] tokenHex in
            guard let client = self?.client else { return }
            try? await client.unregisterLiveActivity(token: tokenHex)
        }
    }

    /// Put a turn on the lock screen (idempotent; no-ops when Live
    /// Activities are off system-side).
    private func startLiveActivity(sessionId: String) {
        guard let session = sessionList.sessions[sessionId] else { return }
        // cliType is pinned on the session row since Phase 1.
        let agentType = session.cliType ?? "custom"
        LiveActivityManager.shared.start(session: session, agentType: agentType)
    }

    /// Toggle handler. Returns false when the user denied the system
    /// permission prompt (the toggle should snap back off).
    @discardableResult
    func setPushEnabled(_ enabled: Bool) async -> Bool {
        if enabled {
            let granted = await PushManager.shared.requestAndRegister()
            pushEnabled = granted
            UserDefaults.standard.set(granted, forKey: Self.pushEnabledKey)
            return granted
        }
        pushEnabled = false
        UserDefaults.standard.set(false, forKey: Self.pushEnabledKey)
        PushManager.shared.unregister()
        if let token = UserDefaults.standard.string(forKey: Self.pushTokenKey), let client {
            UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
            Task { try? await client.unregisterDevice(token: token) }
        }
        return true
    }

    /// Best-effort server-side cleanup before credentials vanish.
    private func unregisterDeviceForLogout() {
        guard let client,
              let token = UserDefaults.standard.string(forKey: Self.pushTokenKey)
        else { return }
        UserDefaults.standard.removeObject(forKey: Self.pushTokenKey)
        Task { try? await client.unregisterDevice(token: token) }
    }

    /// Central 401 funnel — call from any store/view catch block.
    func handleAPIError(_ error: Error) {
        if let apiError = error as? APIError, apiError.isUnauthorized {
            logOut()
        }
    }

    // MARK: Session view-model cache

    /// Cached-or-new view-model for a session. Reuses the cached one
    /// when present so its transcript renders instantly; the caller
    /// still runs `start()`, which revalidates a cached transcript.
    /// Returns nil before the client/socket exist (mid-login teardown).
    ///
    /// `agentType` keys the usage/context parsers and is frozen at VM
    /// init, so a cached VM built while the fleet list was still
    /// loading (type fell back to "custom") is REPLACED once the real
    /// type is known — otherwise the wrong parser would stick for the
    /// cache's lifetime. The reverse (cached real type, caller passes
    /// the "custom" fallback) keeps the cached VM: it knows more than
    /// the caller.
    func sessionViewModel(for sessionId: String, agentType: AgentType) -> SessionViewModel? {
        guard let client, let stream else { return nil }
        if let cached = sessionVMs[sessionId],
           cached.agentType == agentType || agentType == "custom" {
            touchSessionVM(sessionId)
            return cached
        }
        let vm = SessionViewModel(
            sessionId: sessionId,
            agentType: agentType,
            client: client,
            stream: stream,
            onAuthError: { [weak self] in self?.handleAPIError($0) }
        )
        sessionVMs[sessionId] = vm
        touchSessionVM(sessionId)
        evictSessionVMs()
        return vm
    }

    private func touchSessionVM(_ sessionId: String) {
        sessionVMOrder.removeAll { $0 == sessionId }
        sessionVMOrder.append(sessionId)
    }

    private func evictSessionVMs() {
        while sessionVMs.count > Self.sessionVMCacheLimit {
            // Never evict the session on screen — live chunks route to it.
            guard let victim = sessionVMOrder.first(where: { sessionVMs[$0] !== activeSession })
            else { return }
            sessionVMs[victim] = nil
            sessionVMOrder.removeAll { $0 == victim }
        }
    }

    // MARK: Data

    func refreshAll() async {
        guard let client else { return }
        // Agents are retired (Phase 4): the sidebar groups sessions by
        // projectId over the project store. includeArchived keeps
        // archived sessions reachable via the per-project eye toggle.
        // Each list applies independently so one transient failure can't
        // abort the rest; 401s funnel through handleAPIError.
        async let machines = client.listMachines()
        async let projects = client.listProjects()
        async let sessions = client.listSessions(includeArchived: true)
        async let userExtensions = client.getMyExtensions()
        do { fleet.setMachines(try await machines) } catch { handleAPIError(error) }
        do { fleet.setProjects(try await projects) } catch { handleAPIError(error) }
        do { sessionList.setAll(try await sessions) } catch { handleAPIError(error) }
        do { extensions = try await userExtensions } catch { handleAPIError(error) }
        maybeDrainAllQueues()
    }

    /// PUT the full extension flag set (no server-side merge), keeping
    /// the app-wide copy in sync. Optimistic with revert on failure.
    func setExtensions(_ newValue: UserExtensions) async {
        guard let client else { return }
        let previous = extensions
        extensions = newValue
        do {
            extensions = try await client.setMyExtensions(newValue)
        } catch {
            handleAPIError(error)
            extensions = previous
        }
    }

    // MARK: Creation (project-first)

    /// Create a session in a project with ONE call: the request carries
    /// the `(machineId, workingDir, cliType)` triple and the server
    /// upserts the Project row and pins the session to it (the Agent
    /// entity is retired — sessions route by `projectId → machine +
    /// cliType`). Returns the new session (already upserted + routed).
    func createSession(
        machineId: String,
        workingDir: String?,
        adapterType: AgentType,
        title: String?,
        modelSelection: ModelSelection? = nil
    ) async throws -> SessionDTO {
        guard let client else {
            throw APIError(status: 0, message: "Not connected")
        }
        let created = try await client.createSession(CreateSessionRequest(
            machineId: machineId,
            workingDir: workingDir?.isEmpty == false ? workingDir : nil,
            cliType: adapterType,
            title: title?.isEmpty == false ? title : nil,
            modelSelection: modelSelection?.isEmpty == false ? modelSelection : nil
        ))
        sessionList.upsert(created.session)
        route = .session(created.session.id)
        return created.session
    }

    // MARK: Prompt queue drainer

    /// Route a composer submit through the queue: joining the FIFO tail
    /// keeps manual sends from jumping a draining backlog, and the
    /// drainer dispatches immediately when the session is free — so the
    /// idle case still feels like a direct send.
    func submitPrompt(sessionId: String, text: String, attachmentIds: [String]) {
        queue.enqueue(sessionId: sessionId, text: text, attachmentIds: attachmentIds)
        maybeDrain(sessionId: sessionId)
    }

    func maybeDrainAllQueues() {
        for sessionId in Set(queue.items.map(\.sessionId)) {
            maybeDrain(sessionId: sessionId)
        }
    }

    private func maybeDrain(sessionId: String) {
        guard let client, let head = queue.head(for: sessionId) else { return }
        // Unknown session yet (lists still loading) → retry on refresh.
        guard let session = sessionList.sessions[sessionId] else { return }
        // The ONE invariant: never two turns for the same session.
        guard session.status != .active else { return }
        if let since = drainInFlight[sessionId], Date().timeIntervalSince(since) < 30 { return }
        if let until = drainCooldown[sessionId], Date() < until { return }
        // Reachability is MACHINE-level since the runner refactor:
        // liveness belongs to the sidecar process. Resolve the machine
        // through the session's pinned project; a session with no
        // resolvable machine (workdir-less, or Project row not hydrated
        // yet) is left drainable rather than blocked. Busy stays
        // per-session, never per-agent.
        if let machineId = fleet.projectRef(for: session)?.machineId {
            guard fleet.machines[machineId]?.status == .online else { return }
        }

        drainInFlight[sessionId] = Date()
        Task {
            do {
                let command = try await client.sendCommand(
                    sessionId: sessionId,
                    CreateCommandRequest(
                        prompt: head.text,
                        attachmentIds: head.attachmentIds.isEmpty ? nil : head.attachmentIds
                    )
                )
                queue.remove(id: head.id)
                activeSession?.ingest(command: command)
                // Turns submitted from THIS device get a lock-screen
                // card immediately (ActivityKit needs foreground — this
                // is the natural moment).
                startLiveActivity(sessionId: sessionId)
                // drainInFlight stays set until the session goes active
                // (or the 30s bridge expires) — that's the guard window.
            } catch {
                drainInFlight[sessionId] = nil
                drainCooldown[sessionId] = Date().addingTimeInterval(60)
                handleAPIError(error)
                if activeSession?.sessionId == sessionId {
                    activeSession?.actionError =
                        (error as? APIError)?.message ?? error.localizedDescription
                }
            }
        }
    }

    // MARK: Socket

    private func makeClient(config: ServerConfig) -> ArgusClient {
        let box = tokenBox
        return ArgusClient(baseURL: config.baseURL, tokenProvider: { box.get() })
    }

    private func connectSocket() {
        guard let config = serverConfig, let token = tokenBox.get() else { return }
        let stream = StreamClient()
        self.stream = stream
        stream.connect(baseURL: config.baseURL, token: token)
        eventPump?.cancel()
        eventPump = Task { [weak self] in
            for await event in stream.events {
                guard let self, !Task.isCancelled else { return }
                self.handle(event)
            }
        }
    }

    private func handle(_ event: ServerEvent) {
        switch event {
        case .connected:
            socketConnected = true
            // Socket.IO rooms don't survive reconnects; delivery has no
            // replay. Rejoin + backfill, and refresh the lists we may
            // have missed events for.
            Task {
                await refreshAll()
                await activeSession?.handleReconnect()
            }
            activeTerminal?.handleReconnect()
        case .disconnected:
            socketConnected = false
        case .socketError:
            break

        case .chunk(let chunk):
            activeSession?.ingestLive(chunk: chunk)
            if let sessionId = chunk.sessionId {
                LiveActivityManager.shared.noteChunk(sessionId: sessionId, chunk: chunk)
            }
        case .commandCreated(let command), .commandUpdated(let command):
            activeSession?.ingest(command: command)

        case .sessionCreated(let session), .sessionUpdated(let session):
            sessionList.upsert(session)
        case .sessionStatus(let status):
            sessionList.applyStatus(status)
            activeSession?.handleStatus(status)
            if status.status == .active {
                // Dispatch→active bridge closed; the queue stays parked
                // until this turn finishes.
                drainInFlight[status.id] = nil
                // A turn started in the session on screen → lock-screen
                // card (turns submitted from this device start theirs in
                // the drainer; this covers e.g. queued follow-ups too).
                if status.id == activeSession?.sessionId {
                    startLiveActivity(sessionId: status.id)
                }
            } else {
                LiveActivityManager.shared.end(
                    sessionId: status.id,
                    failed: status.status == .failed
                )
                maybeDrain(sessionId: status.id)
            }
        case .sessionCloneFailed:
            break

        case .machineUpsert(let machine):
            fleet.upsert(machine: machine)
        case .machineStatus(let payload):
            fleet.applyMachineStatus(payload)
        case .machineRemoved(let payload):
            fleet.removeMachine(id: payload.id)

        case .projectUpsert(let project):
            fleet.upsert(project: project)

        case .fsChanged(let payload):
            lastFSChange = payload
        case .gitChanged(let payload):
            lastGitChange = payload

        case .backgroundTaskUpdated(let task):
            lastBackgroundTaskUpdate = task
        case .backgroundTaskRemoved(let payload):
            lastBackgroundTaskRemoval = payload

        case .terminalOutput, .terminalClosed:
            activeTerminal?.handle(event)
        case .terminalCreated, .terminalUpdated:
            break
        }
    }
}

/// What the split view's detail column shows — the iOS counterpart of
/// the web's routes (/sessions/:id, /machines/:id, /user). Doubles as
/// the sidebar List selection tag.
enum DetailRoute: Hashable {
    case session(String)
    case machine(String)
    case user
}

/// Lock-guarded JWT holder. URLSession invokes the client's token
/// provider on its own threads, so the token must be readable without
/// hopping to the main actor.
final class TokenBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ newValue: String?) {
        lock.lock()
        defer { lock.unlock() }
        value = newValue
    }
}
