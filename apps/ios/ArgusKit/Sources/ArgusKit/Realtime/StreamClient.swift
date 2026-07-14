import Foundation
import SocketIO

// Realtime layer — the Swift counterpart of `apps/web/src/lib/ws.ts`,
// against the event map in `packages/shared-types/src/ws.ts`.
//
// Auth: the server (`stream.gateway.ts#handleConnection`) reads the JWT
// from `handshake.auth.token`. We send it via the Socket.IO CONNECT
// payload (`connect(withPayload:)`) — unlike a header this travels inside
// the Engine.IO CONNECT packet, so it survives proxies.
//
// Delivery is best-effort: on `.connected` after a drop, the app must
// backfill missed chunks over REST (`getSessionChunks(afterSeq:)`) —
// there is no socket-side replay buffer.

/// Small payloads for events that don't carry a full DTO.
public struct IdStatusPayload: Decodable, Equatable, Sendable {
    public let id: String
    public let status: String
}

public struct IdPayload: Decodable, Equatable, Sendable {
    public let id: String
}

public struct AgentSpawnFailedPayload: Decodable, Equatable, Sendable {
    public let machineId: String
    public let agentId: String
    public let reason: String
}

public struct SessionCloneFailedPayload: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let reason: String
}

/// fs/git nudges carry two identities during the mixed-fleet window:
/// legacy sidecars send only `agentId`; runner sidecars send the
/// `(machineId, workingDir)` pair with an EMPTY agentId (the event fans
/// out to the project room only). Match on the pair when `workingDir`
/// is non-empty, else on agentId. All fields optional for tolerance —
/// a dropped identity must degrade matching, never decoding.
public struct FSChangedPayload: Decodable, Equatable, Sendable {
    public let agentId: String?
    public let path: String
    public let machineId: String?
    public let workingDir: String?
}

public struct GitChangedPayload: Decodable, Equatable, Sendable {
    public let agentId: String?
    public let machineId: String?
    public let workingDir: String?
}

/// The server's retention window for an ended task elapsed (or a user
/// dismissed it) — drop the row.
public struct BackgroundTaskRemovedPayload: Decodable, Equatable, Sendable {
    public let machineId: String
    public let workingDir: String
    public let taskId: String
}

/// One chunk of PTY output. `data` is base64 raw bytes; `seq` is the
/// duplicate guard (feed strictly increasing seqs only).
public struct TerminalOutputPayload: Decodable, Equatable, Sendable {
    public let terminalId: String
    public let seq: Int
    public let data: String
}

public struct TerminalClosedPayload: Decodable, Equatable, Sendable {
    public let terminalId: String
    public let exitCode: Int?
    public let reason: String?
}

/// One live event from the `/stream` namespace — the Phase-1 subset plus
/// fleet upkeep. Terminal, background-task, and sidecar-update events are
/// wired in later phases.
public enum ServerEvent: Sendable {
    case connected
    case disconnected
    case socketError(String)

    case chunk(ResultChunk)
    case commandCreated(CommandDTO)
    case commandUpdated(CommandDTO)

    case sessionCreated(SessionDTO)
    case sessionUpdated(SessionDTO)
    case sessionStatus(SessionStatusEvent)
    case sessionCloneFailed(SessionCloneFailedPayload)

    case agentUpsert(AgentDTO)
    case agentStatus(IdStatusPayload)
    case agentRemoved(IdPayload)
    case agentSpawnFailed(AgentSpawnFailedPayload)

    case machineUpsert(MachineDTO)
    case machineStatus(IdStatusPayload)
    case machineRemoved(IdPayload)

    case projectUpsert(ProjectDTO)

    case fsChanged(FSChangedPayload)
    case gitChanged(GitChangedPayload)

    /// Scoped to `project:<machineId>:<workingDir>` rooms
    /// (`subscribe:project`).
    case backgroundTaskUpdated(BackgroundTaskDTO)
    case backgroundTaskRemoved(BackgroundTaskRemovedPayload)

    /// created/updated arrive on the user room; output/closed on the
    /// `terminal:{id}` room (`subscribe:terminal`).
    case terminalCreated(TerminalDTO)
    case terminalUpdated(TerminalDTO)
    case terminalOutput(TerminalOutputPayload)
    case terminalClosed(TerminalClosedPayload)
}

/// Owns the Socket.IO connection and surfaces typed events as an
/// `AsyncStream`. Create one per login; `connect` after login, `shutdown`
/// on logout.
@MainActor
public final class StreamClient {
    /// Consume once; delivers every event for the client's lifetime.
    public let events: AsyncStream<ServerEvent>
    private let continuation: AsyncStream<ServerEvent>.Continuation

    private var manager: SocketManager?
    private var socket: SocketIOClient?

    public init() {
        var streamContinuation: AsyncStream<ServerEvent>.Continuation!
        self.events = AsyncStream(bufferingPolicy: .unbounded) { streamContinuation = $0 }
        self.continuation = streamContinuation
    }

    // MARK: Lifecycle

    public func connect(baseURL: URL, token: String) {
        shutdownSocketKeepingStream()
        // Reconnection mirrors ws.ts: always retry, capped backoff.
        let manager = SocketManager(
            socketURL: baseURL,
            config: [
                .forceWebsockets(true),
                .reconnects(true),
                .reconnectWait(1),
                .reconnectWaitMax(10),
                .log(false),
            ]
        )
        let socket = manager.socket(forNamespace: "/stream")
        self.manager = manager
        self.socket = socket
        registerHandlers(on: socket)
        socket.connect(withPayload: ["token": token])
    }

    public func shutdown() {
        shutdownSocketKeepingStream()
        continuation.finish()
    }

    private func shutdownSocketKeepingStream() {
        socket?.disconnect()
        socket?.removeAllHandlers()
        socket = nil
        manager = nil
    }

    // MARK: Rooms

    public func joinSession(_ id: String) { socket?.emit("subscribe:session", id) }
    public func leaveSession(_ id: String) { socket?.emit("unsubscribe:session", id) }
    public func joinAgent(_ id: String) { socket?.emit("subscribe:agent", id) }
    public func leaveAgent(_ id: String) { socket?.emit("unsubscribe:agent", id) }

    public func joinProject(machineId: String, workingDir: String) {
        socket?.emit("subscribe:project", ["machineId": machineId, "workingDir": workingDir])
    }

    public func leaveProject(machineId: String, workingDir: String) {
        socket?.emit("unsubscribe:project", ["machineId": machineId, "workingDir": workingDir])
    }

    public func joinTerminal(_ id: String) { socket?.emit("subscribe:terminal", id) }
    public func leaveTerminal(_ id: String) { socket?.emit("unsubscribe:terminal", id) }

    // MARK: Terminal input (client → server; bytes ride base64 in JSON)

    public func sendTerminalInput(terminalId: String, base64Data: String) {
        socket?.emit("terminal:input", ["terminalId": terminalId, "data": base64Data])
    }

    public func sendTerminalResize(terminalId: String, cols: Int, rows: Int) {
        socket?.emit("terminal:resize", ["terminalId": terminalId, "cols": cols, "rows": rows])
    }

    public func sendTerminalClose(terminalId: String) {
        socket?.emit("terminal:close", terminalId)
    }

    // MARK: Handlers

    private func registerHandlers(on socket: SocketIOClient) {
        socket.on(clientEvent: .connect) { [weak self] _, _ in
            self?.continuation.yield(.connected)
        }
        socket.on(clientEvent: .disconnect) { [weak self] _, _ in
            self?.continuation.yield(.disconnected)
        }
        socket.on(clientEvent: .error) { [weak self] data, _ in
            self?.continuation.yield(.socketError(String(describing: data.first ?? "socket error")))
        }

        on(socket, "chunk", ServerEvent.chunk)
        on(socket, "command:created", ServerEvent.commandCreated)
        on(socket, "command:updated", ServerEvent.commandUpdated)
        on(socket, "session:created", ServerEvent.sessionCreated)
        on(socket, "session:updated", ServerEvent.sessionUpdated)
        on(socket, "session:status", ServerEvent.sessionStatus)
        on(socket, "session:clone-failed", ServerEvent.sessionCloneFailed)
        on(socket, "agent:upsert", ServerEvent.agentUpsert)
        on(socket, "agent:status", ServerEvent.agentStatus)
        on(socket, "agent:removed", ServerEvent.agentRemoved)
        on(socket, "agent:spawn-failed", ServerEvent.agentSpawnFailed)
        on(socket, "machine:upsert", ServerEvent.machineUpsert)
        on(socket, "machine:status", ServerEvent.machineStatus)
        on(socket, "machine:removed", ServerEvent.machineRemoved)
        on(socket, "project:upsert", ServerEvent.projectUpsert)
        on(socket, "fs:changed", ServerEvent.fsChanged)
        on(socket, "git:changed", ServerEvent.gitChanged)
        on(socket, "background-task:updated", ServerEvent.backgroundTaskUpdated)
        on(socket, "background-task:removed", ServerEvent.backgroundTaskRemoved)
        on(socket, "terminal:created", ServerEvent.terminalCreated)
        on(socket, "terminal:updated", ServerEvent.terminalUpdated)
        on(socket, "terminal:output", ServerEvent.terminalOutput)
        on(socket, "terminal:closed", ServerEvent.terminalClosed)
    }

    /// Register a typed handler: decode the event's first argument into
    /// `T`, wrap with `make`, yield. Undecodable payloads are dropped —
    /// realtime events always have a REST fallback path.
    private func on<T: Decodable>(
        _ socket: SocketIOClient,
        _ event: String,
        _ make: @escaping @Sendable (T) -> ServerEvent
    ) {
        socket.on(event) { [weak self] data, _ in
            guard let value: T = Self.decodeFirst(data) else { return }
            self?.continuation.yield(make(value))
        }
    }

    /// Decode the first Socket.IO argument (a JSON object) by
    /// round-tripping JSONSerialization → JSONDecoder.
    private static func decodeFirst<T: Decodable>(_ data: [Any]) -> T? {
        guard let first = data.first,
              JSONSerialization.isValidJSONObject(first),
              let json = try? JSONSerialization.data(withJSONObject: first)
        else { return nil }
        return try? JSONDecoder().decode(T.self, from: json)
    }
}
