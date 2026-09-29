package app.argus.core.realtime

import app.argus.core.ArgusJson
import app.argus.core.model.CommandDTO
import app.argus.core.model.MachineDTO
import app.argus.core.model.ProjectDTO
import app.argus.core.model.ResultChunk
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionStatusEvent
import app.argus.core.model.TerminalDTO
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/**
 * Realtime layer — the Kotlin counterpart of ArgusKit's `StreamClient`
 * and of `apps/web/src/lib/ws.ts`, against the event map in
 * `packages/shared-types/src/ws.ts`.
 *
 * Auth: the server (`stream.gateway.ts#handleConnection`) reads the JWT
 * from `handshake.auth.token`, sent here as the Socket.IO `auth` payload —
 * unlike a header this travels inside the Engine.IO CONNECT packet, so it
 * survives proxies.
 *
 * Delivery is best-effort: on [ServerEvent.Connected] after a drop, the
 * app must backfill missed chunks over REST (`getSessionChunks(afterSeq)`)
 * — there is no socket-side replay buffer — and replay its room
 * memberships with [rejoinProjectRooms] (rooms are per connection).
 *
 * Threading: Socket.IO invokes listeners on its own thread; they only
 * touch the unbounded [Channel], which is thread-safe. Everything else
 * (connect, rooms, emits) is expected from one thread — the app's main.
 * Create one per login; [connect] after login, [shutdown] on logout.
 */
class StreamClient(private val httpClient: OkHttpClient = OkHttpClient()) {
    private val channel = Channel<ServerEvent>(Channel.UNLIMITED)

    /** Consume once; delivers every event for the client's lifetime. */
    val events: Flow<ServerEvent> = channel.receiveAsFlow()

    private var socket: Socket? = null
    private val rooms = ProjectRoomRegistry()

    /** Held project rooms → holder count (see [ProjectRoomRegistry]). */
    val projectRooms: Map<ProjectRoomKey, Int>
        get() = rooms.snapshot()

    // MARK: Lifecycle

    fun connect(baseUrl: String, token: String) {
        shutdownSocketKeepingStream()
        // Reconnection mirrors ws.ts: always retry, capped backoff.
        val options = IO.Options.builder()
            .setTransports(arrayOf("websocket"))
            .setReconnection(true)
            .setReconnectionDelay(1_000)
            .setReconnectionDelayMax(10_000)
            .setAuth(mapOf("token" to token))
            .build()
        options.callFactory = httpClient
        options.webSocketFactory = httpClient
        // The URI path IS the namespace for socket.io-client-java.
        val socket = IO.socket(URI.create(baseUrl.trimEnd('/') + NAMESPACE), options)
        this.socket = socket
        registerHandlers(socket)
        socket.connect()
    }

    fun shutdown() {
        shutdownSocketKeepingStream()
        channel.close()
    }

    private fun shutdownSocketKeepingStream() {
        socket?.let {
            it.off()
            it.disconnect()
        }
        socket = null
        // Membership belongs to the connection we just dropped. Both
        // callers (login `connect`, logout `shutdown`) run with no session
        // view on screen, so there are no live holders to orphan; keeping
        // stale counts would instead make the next rejoin resubscribe
        // rooms nobody is watching.
        rooms.clear()
    }

    // MARK: Rooms

    fun joinSession(id: String) {
        socket?.emit("subscribe:session", id)
    }

    fun leaveSession(id: String) {
        socket?.emit("unsubscribe:session", id)
    }

    fun joinProject(machineId: String, workingDir: String) {
        val key = ProjectRoomKey(machineId, workingDir)
        // Holders 2..N are already subscribed on this connection.
        if (rooms.join(key)) emitJoinProject(key)
    }

    fun leaveProject(machineId: String, workingDir: String) {
        val key = ProjectRoomKey(machineId, workingDir)
        if (rooms.leave(key)) {
            socket?.emit("unsubscribe:project", projectPayload(key))
        }
    }

    /**
     * Re-subscribe every held project room after a reconnect. Socket.IO
     * rooms are per-CONNECTION, so a drop silently discards all of them;
     * without a replay, `fs:changed` / `git:changed` stop arriving until
     * the holding view happens to reappear. Call from the app's
     * [ServerEvent.Connected] handler, next to the session/terminal
     * rejoin. Does not mutate the refcounts — the holders haven't
     * changed, only the connection has.
     */
    fun rejoinProjectRooms() {
        for (key in rooms.keys()) emitJoinProject(key)
    }

    private fun emitJoinProject(key: ProjectRoomKey) {
        socket?.emit("subscribe:project", projectPayload(key))
    }

    private fun projectPayload(key: ProjectRoomKey): JSONObject =
        JSONObject().put("machineId", key.machineId).put("workingDir", key.workingDir)

    fun joinTerminal(id: String) {
        socket?.emit("subscribe:terminal", id)
    }

    fun leaveTerminal(id: String) {
        socket?.emit("unsubscribe:terminal", id)
    }

    // MARK: Terminal input (client → server; bytes ride base64 in JSON)

    fun sendTerminalInput(terminalId: String, base64Data: String) {
        socket?.emit("terminal:input", JSONObject().put("terminalId", terminalId).put("data", base64Data))
    }

    fun sendTerminalResize(terminalId: String, cols: Int, rows: Int) {
        socket?.emit(
            "terminal:resize",
            JSONObject().put("terminalId", terminalId).put("cols", cols).put("rows", rows),
        )
    }

    fun sendTerminalClose(terminalId: String) {
        socket?.emit("terminal:close", terminalId)
    }

    // MARK: Handlers

    private fun registerHandlers(socket: Socket) {
        socket.on(Socket.EVENT_CONNECT, Emitter.Listener { channel.trySend(ServerEvent.Connected) })
        socket.on(Socket.EVENT_DISCONNECT, Emitter.Listener { channel.trySend(ServerEvent.Disconnected) })
        socket.on(
            Socket.EVENT_CONNECT_ERROR,
            Emitter.Listener { args ->
                channel.trySend(ServerEvent.SocketError(args.firstOrNull()?.toString() ?: "socket error"))
            },
        )

        on<ResultChunk>(socket, "chunk") { ServerEvent.Chunk(it) }
        on<CommandDTO>(socket, "command:created") { ServerEvent.CommandCreated(it) }
        on<CommandDTO>(socket, "command:updated") { ServerEvent.CommandUpdated(it) }
        on<SessionDTO>(socket, "session:created") { ServerEvent.SessionCreated(it) }
        on<SessionDTO>(socket, "session:updated") { ServerEvent.SessionUpdated(it) }
        on<SessionStatusEvent>(socket, "session:status") { ServerEvent.SessionStatusChanged(it) }
        on<SessionCloneFailedPayload>(socket, "session:clone-failed") { ServerEvent.SessionCloneFailed(it) }
        on<MachineDTO>(socket, "machine:upsert") { ServerEvent.MachineUpsert(it) }
        on<IdStatusPayload>(socket, "machine:status") { ServerEvent.MachineStatusChanged(it) }
        on<IdPayload>(socket, "machine:removed") { ServerEvent.MachineRemoved(it) }
        on<ProjectDTO>(socket, "project:upsert") { ServerEvent.ProjectUpsert(it) }
        on<FSChangedPayload>(socket, "fs:changed") { ServerEvent.FsChanged(it) }
        on<GitChangedPayload>(socket, "git:changed") { ServerEvent.GitChanged(it) }
        on<TerminalDTO>(socket, "terminal:created") { ServerEvent.TerminalCreated(it) }
        on<TerminalDTO>(socket, "terminal:updated") { ServerEvent.TerminalUpdated(it) }
        on<TerminalOutputPayload>(socket, "terminal:output") { ServerEvent.TerminalOutput(it) }
        on<TerminalClosedPayload>(socket, "terminal:closed") { ServerEvent.TerminalClosed(it) }
    }

    /**
     * Register a typed handler: decode the event's first argument into
     * [T], wrap with [make], send. Undecodable payloads are dropped —
     * realtime events always have a REST fallback path.
     */
    private inline fun <reified T> on(socket: Socket, event: String, crossinline make: (T) -> ServerEvent) {
        socket.on(
            event,
            Emitter.Listener { args ->
                val first = args.firstOrNull() ?: return@Listener
                val value = decodeArg<T>(first) ?: return@Listener
                channel.trySend(make(value))
            },
        )
    }

    /**
     * socket.io-client-java hands objects over as org.json values; round-
     * trip through their JSON text into the tolerant ArgusJson decoder.
     */
    private inline fun <reified T> decodeArg(arg: Any): T? {
        val text = when (arg) {
            is JSONObject -> arg.toString()
            is JSONArray -> arg.toString()
            is String -> arg
            else -> return null
        }
        return runCatching { ArgusJson.decodeFromString<T>(text) }.getOrNull()
    }

    companion object {
        const val NAMESPACE = "/stream"
    }
}
