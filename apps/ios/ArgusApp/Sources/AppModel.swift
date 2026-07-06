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

    let fleet = FleetStore()
    let sessionList = SessionListStore()

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
        await refreshAll()
    }

    func logOut() {
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
        } catch {
            handleAPIError(error)
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

        case .fsChanged, .gitChanged:
            break
        }
    }
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
