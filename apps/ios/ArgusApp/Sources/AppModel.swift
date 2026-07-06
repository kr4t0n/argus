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
    /// refetch when the agent matches theirs.
    private(set) var lastFSChange: FSChangedPayload?
    private(set) var lastGitChange: GitChangedPayload?

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
        route = nil
        inspectorPresented = false
        drainInFlight = [:]
        drainCooldown = [:]
        fleet.reset()
        sessionList.reset()
        phase = .loggedOut
    }

    func handleForeground() {
        guard phase == .ready else { return }
        Task {
            await refreshAll()
            await activeSession?.reloadSnapshot()
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

    // MARK: Data

    func refreshAll() async {
        guard let client else { return }
        do {
            async let agents = client.listAgents()
            async let machines = client.listMachines()
            async let projects = client.listProjects()
            async let sessions = client.listSessions()
            fleet.setAgents(try await agents)
            fleet.setMachines(try await machines)
            fleet.setProjects(try await projects)
            sessionList.setAll(try await sessions)
            maybeDrainAllQueues()
        } catch {
            handleAPIError(error)
        }
    }

    // MARK: Creation (auto-vivify, mirrors the web's CreateAgentPopover)

    /// Create a session in a project: reuse an existing agent of the
    /// chosen type within `(machineId, workingDir)` if one exists,
    /// otherwise create one with an auto-generated name first — the
    /// agent layer is implementation detail, exactly like the web
    /// sidebar. Returns the new session (already upserted + routed).
    func createSession(
        machineId: String,
        workingDir: String?,
        adapterType: AgentType,
        title: String?
    ) async throws -> SessionDTO {
        guard let client else {
            throw APIError(status: 0, message: "Not connected")
        }
        let agent: AgentDTO
        if let existing = fleet.agents.values.first(where: {
            $0.machineId == machineId
                && $0.type == adapterType
                && $0.workingDir == workingDir
                && $0.archivedAt == nil
        }) {
            agent = existing
        } else {
            let suffix = String(UUID().uuidString.prefix(6)).lowercased()
            agent = try await client.createAgent(
                machineId: machineId,
                CreateAgentRequest(
                    name: "\(adapterType)-\(suffix)",
                    type: adapterType,
                    workingDir: workingDir
                )
            )
            fleet.upsert(agent: agent)
        }
        let created = try await client.createSession(CreateSessionRequest(
            agentId: agent.id,
            title: title?.isEmpty == false ? title : nil
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
        // Agent reachability only — busy is per-session, not per-agent.
        if let agent = fleet.agents[session.agentId],
           agent.status == .offline || agent.status == .error { return }

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
        case .disconnected:
            socketConnected = false
        case .socketError:
            break

        case .chunk(let chunk):
            activeSession?.ingestLive(chunk: chunk)
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
            } else {
                maybeDrain(sessionId: status.id)
            }
        case .sessionCloneFailed:
            break

        case .agentUpsert(let agent):
            fleet.upsert(agent: agent)
        case .agentStatus(let payload):
            fleet.applyAgentStatus(payload)
        case .agentRemoved(let payload):
            fleet.removeAgent(id: payload.id)
        case .agentSpawnFailed:
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
