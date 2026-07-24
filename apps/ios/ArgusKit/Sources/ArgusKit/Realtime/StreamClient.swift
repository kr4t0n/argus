import Foundation
// SocketIO hasn't adopted Sendable; @preconcurrency relaxes strict
// checking at its API boundary only (our own code stays fully checked).
@preconcurrency import SocketIO

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

public struct SessionCloneFailedPayload: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let reason: String
}

/// fs/git nudges are scoped to the `(machineId, workingDir)` project the
/// runner emitted them for; panels match on that pair. Both fields
/// optional for tolerance — a dropped identity must degrade matching,
/// never decoding.
public struct FSChangedPayload: Decodable, Equatable, Sendable {
    public let path: String
    public let machineId: String?
    public let workingDir: String?
}

public struct GitChangedPayload: Decodable, Equatable, Sendable {
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

/// Identifies one project room. A Hashable struct rather than a joined
/// string so there's no separator for a `workingDir` to collide on —
/// `("a", "b/c")` and `("a/b", "c")` are distinct rooms.
///
/// File scope, not nested in `StreamClient`: a type nested inside a
/// `@MainActor` class inherits that isolation, which fights the
/// `Sendable` conformance a dictionary key wants.
struct ProjectRoomKey: Hashable, Sendable {
    let machineId: String
    let workingDir: String
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
        // Membership belongs to the connection we just dropped. Both
        // callers (login `connect`, logout `shutdown`) run with no
        // session view on screen, so there are no live holders to
        // orphan; keeping stale counts would instead make the next
        // `rejoinProjectRooms()` resubscribe rooms nobody is watching.
        projectRooms.removeAll()
    }

    // MARK: Rooms

    public func joinSession(_ id: String) { socket?.emit("subscribe:session", id) }
    public func leaveSession(_ id: String) { socket?.emit("unsubscribe:session", id) }

    /// Held project rooms → holder count. A REFCOUNT, not a flag: the
    /// inspector, the file-preview sheet, and anything else wanting
    /// `fs:changed` subscribe independently, and Socket.IO's `leave` is
    /// not refcounted — so without this the first holder to disappear
    /// unsubscribes the socket out from under the others.
    ///
    /// Doubles as the replay list for `rejoinProjectRooms()`.
    private(set) var projectRooms: [ProjectRoomKey: Int] = [:]

    public func joinProject(machineId: String, workingDir: String) {
        let key = ProjectRoomKey(machineId: machineId, workingDir: workingDir)
        let holders = (projectRooms[key] ?? 0) + 1
        projectRooms[key] = holders
        // Holders 2..N are already subscribed on this connection.
        if holders == 1 { emitJoinProject(key) }
    }

    public func leaveProject(machineId: String, workingDir: String) {
        let key = ProjectRoomKey(machineId: machineId, workingDir: workingDir)
        let holders = (projectRooms[key] ?? 0) - 1
        if holders > 0 {
            projectRooms[key] = holders
            return
        }
        projectRooms[key] = nil
        socket?.emit("unsubscribe:project", ["machineId": machineId, "workingDir": workingDir])
    }

    /// Re-subscribe every held project room after a reconnect.
    ///
    /// Socket.IO rooms are per-CONNECTION, so a drop silently discards
    /// all of them. Nothing replayed them before, so after any blip
    /// `fs:changed` / `git:changed` stopped arriving until the holding
    /// view happened to reappear — on mobile, where drops are routine,
    /// that meant the inspector's file tree and commit list quietly went
    /// dead while still looking live.
    ///
    /// Called from `AppModel`'s `.connected` handler, next to the
    /// session/terminal rejoin. Deliberately NOT called from the socket's
    /// own connect callback: those closures run outside this actor
    /// (SocketIO is a `@preconcurrency` import) and must not touch
    /// actor-isolated state — which is why every other handler in this
    /// file only ever touches `continuation`.
    public func rejoinProjectRooms() {
        for key in projectRooms.keys { emitJoinProject(key) }
    }

    private func emitJoinProject(_ key: ProjectRoomKey) {
        socket?.emit(
            "subscribe:project",
            ["machineId": key.machineId, "workingDir": key.workingDir]
        )
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

        // Closure literals, not `ServerEvent.case` references: the
        // compiler doesn't infer @Sendable for unapplied enum-case
        // constructors, so the references warn under strict concurrency.
        on(socket, "chunk") { .chunk($0) }
        on(socket, "command:created") { .commandCreated($0) }
        on(socket, "command:updated") { .commandUpdated($0) }
        on(socket, "session:created") { .sessionCreated($0) }
        on(socket, "session:updated") { .sessionUpdated($0) }
        on(socket, "session:status") { .sessionStatus($0) }
        on(socket, "session:clone-failed") { .sessionCloneFailed($0) }
        on(socket, "machine:upsert") { .machineUpsert($0) }
        on(socket, "machine:status") { .machineStatus($0) }
        on(socket, "machine:removed") { .machineRemoved($0) }
        on(socket, "project:upsert") { .projectUpsert($0) }
        on(socket, "fs:changed") { .fsChanged($0) }
        on(socket, "git:changed") { .gitChanged($0) }
        on(socket, "background-task:updated") { .backgroundTaskUpdated($0) }
        on(socket, "background-task:removed") { .backgroundTaskRemoved($0) }
        on(socket, "terminal:created") { .terminalCreated($0) }
        on(socket, "terminal:updated") { .terminalUpdated($0) }
        on(socket, "terminal:output") { .terminalOutput($0) }
        on(socket, "terminal:closed") { .terminalClosed($0) }
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
