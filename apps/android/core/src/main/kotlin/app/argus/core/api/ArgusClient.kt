package app.argus.core.api

import app.argus.core.ArgusJson
import app.argus.core.model.ActivityDay
import app.argus.core.model.AttachmentDTO
import app.argus.core.model.AuthUser
import app.argus.core.model.CommandDTO
import app.argus.core.model.CreateCommandRequest
import app.argus.core.model.CreateSessionRequest
import app.argus.core.model.CreateSessionResponse
import app.argus.core.model.DeviceDTO
import app.argus.core.model.FSListResponse
import app.argus.core.model.FSReadResponse
import app.argus.core.model.GitLogResponse
import app.argus.core.model.LoginRequest
import app.argus.core.model.LoginResponse
import app.argus.core.model.MachineDTO
import app.argus.core.model.MeResponse
import app.argus.core.model.ModelCatalogResponse
import app.argus.core.model.ModelSelection
import app.argus.core.model.ProjectDTO
import app.argus.core.model.ProjectNotesResponse
import app.argus.core.model.PushConfigDTO
import app.argus.core.model.SessionChunksResponse
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionDetailResponse
import app.argus.core.model.SessionHistoryResponse
import app.argus.core.model.SessionSearchResponse
import app.argus.core.model.SidecarUpdateAccepted
import app.argus.core.model.SidecarVersionInfo
import app.argus.core.model.TerminalDTO
import app.argus.core.model.UpdateSessionModelRequest
import app.argus.core.model.UserActivityResponse
import app.argus.core.model.UserExtensions
import app.argus.core.model.UserQuotaResponse
import app.argus.core.model.UserQuotaRow
import app.argus.core.model.UserUsageResponse
import app.argus.core.model.WindowedUsage
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Hand-written REST client — the Kotlin counterpart of ArgusKit's
 * `ArgusClient` and of `apps/web/src/lib/api.ts`, which is the behavioral
 * reference for every endpoint here (paths, query params, envelopes).
 *
 * Deliberately NOT generated: models decode tolerantly (unknown fields
 * ignored, open enums fall back) so server-side additions never break a
 * shipped build. When shared-types changes shape, update the mirror in
 * model/ and refresh the shared fixtures (`scripts/capture-client-fixtures.sh`).
 *
 * The JWT is held by [tokenProvider] — keep it in memory and persist it
 * separately; a per-request credential-store read is a measurable cost.
 *
 * Responses are gzipped by the server; OkHttp negotiates and inflates
 * that transparently as long as no `Accept-Encoding` header is set here.
 */
class ArgusClient(
    baseUrl: String,
    private val tokenProvider: () -> String?,
    httpClient: OkHttpClient = OkHttpClient(),
) {
    /** Normalized base (no trailing slash); paths are concatenated, not resolved. */
    val baseUrl: String = baseUrl.trimEnd('/')

    private val http: OkHttpClient = httpClient

    /**
     * `POST /sessions/:id/fork` HOLDS its response until the sidecar's
     * clone settles, bounded server-side by FORK_CLONE_TIMEOUT_MS (15 s).
     * OkHttp's default read timeout is 10 s, so a fork needs its own
     * budget or every Codex fork times out client-side while succeeding
     * on the server.
     */
    private val longHoldHttp: OkHttpClient =
        httpClient.newBuilder().readTimeout(FORK_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS).build()

    /**
     * Absolutize an API-base-relative path (e.g. AttachmentDTO.url — those
     * authenticate via their `?t=` token, not a header).
     */
    fun absoluteUrl(path: String): String = baseUrl + path

    // MARK: Auth

    suspend fun login(email: String, password: String): LoginResponse =
        send("POST", "/auth/login", body = json(LoginRequest(email, password)))

    suspend fun me(): AuthUser = send<MeResponse>("GET", "/auth/me").user

    // MARK: Sessions

    suspend fun listSessions(includeArchived: Boolean = false): List<SessionDTO> =
        send("GET", "/sessions", query = flag("includeArchived", includeArchived))

    /**
     * Content search across every session the caller owns, archived
     * included — the Ctrl+K palette's backend. The server returns one hit
     * per session (its best-matching turn + how many turns matched);
     * titles/projects come from the lists the client already holds.
     * The server rejects an empty query; the palette mirrors the web's
     * two-character floor client-side to save the round-trip.
     */
    suspend fun searchSessions(query: String, limit: Int? = null): SessionSearchResponse {
        val items = mutableListOf("q" to query)
        if (limit != null) items += "limit" to limit.toString()
        return send("GET", "/search/sessions", query = items)
    }

    /** Initial load: last [tailCommands] turns (+ `hasMore` for scroll-up). */
    suspend fun getSession(id: String, tailCommands: Int? = null): SessionDetailResponse {
        val query = mutableListOf<Pair<String, String>>()
        if (tailCommands != null) query += "tailCommands" to tailCommands.toString()
        return send("GET", "/sessions/$id", query = query)
    }

    /** Reconnect backfill: every chunk with seq > [afterSeq], plus commands. */
    suspend fun getSessionChunks(id: String, afterSeq: Int): SessionChunksResponse =
        send("GET", "/sessions/$id/chunks", query = listOf("afterSeq" to afterSeq.toString()))

    /** Scroll-up pagination: turns strictly older than [beforeCommandId]. */
    suspend fun getSessionHistory(
        id: String,
        beforeCommandId: String,
        limit: Int = 20,
    ): SessionHistoryResponse = send(
        "GET", "/sessions/$id/history",
        query = listOf("before" to beforeCommandId, "limit" to limit.toString()),
    )

    suspend fun createSession(request: CreateSessionRequest): CreateSessionResponse =
        send("POST", "/sessions", body = json(request))

    suspend fun renameSession(id: String, title: String): SessionDTO =
        send("PATCH", "/sessions/$id", body = buildJsonObject { put("title", title) }.toString())

    suspend fun archiveSession(id: String): SessionDTO = send("POST", "/sessions/$id/archive")

    suspend fun unarchiveSession(id: String): SessionDTO = send("POST", "/sessions/$id/unarchive")

    /** Clear the unread marker; no-op when already seen. */
    suspend fun markSessionSeen(id: String): SessionDTO = send("POST", "/sessions/$id/seen")

    /**
     * Fork at [commandId]. Uses the long-hold client: the server answers
     * only once the CLI-side clone has settled (or timed out at 15 s).
     */
    suspend fun forkSession(id: String, commandId: String, title: String? = null): SessionDTO =
        send(
            "POST", "/sessions/$id/fork",
            body = json(ForkRequest(commandId = commandId, title = title)),
            client = longHoldHttp,
        )

    /** Replace the session-default model; null clears to "CLI default". */
    suspend fun setSessionModel(id: String, modelSelection: ModelSelection?): SessionDTO =
        send(
            "PATCH", "/sessions/$id/model",
            body = UpdateSessionModelRequest(modelSelection).toJson().toString(),
        )

    // MARK: Commands

    suspend fun sendCommand(sessionId: String, request: CreateCommandRequest): CommandDTO =
        send("POST", "/sessions/$sessionId/commands", body = json(request))

    suspend fun cancelCommand(id: String): CommandDTO = send("POST", "/commands/$id/cancel")

    // MARK: Attachments

    /**
     * Upload one file ahead of sending a turn; pass the returned id in
     * `CreateCommandRequest.attachmentIds`. Server caps: 25 MiB/file,
     * 10 files/turn (413/400 surface as [ApiError]). Field name `file`,
     * as the web's `uploadAttachment` sends it.
     */
    suspend fun uploadAttachment(filename: String, mime: String, bytes: ByteArray): AttachmentDTO {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", filename, bytes.toRequestBody(mime.toMediaTypeOrNull()))
            .build()
        val request = buildRequest("POST", "/attachments", emptyList(), body)
        return decode(perform(http, request))
    }

    // MARK: Models

    /**
     * Model catalog keyed (machineId, cliType) — catalogs belong to the
     * machine's installed binary, so the picker can load one before any
     * session of the type exists; [refresh] bypasses the server cache.
     */
    suspend fun getMachineModelCatalog(
        machineId: String,
        cliType: String,
        refresh: Boolean = false,
    ): ModelCatalogResponse {
        val query = mutableListOf("cliType" to cliType)
        if (refresh) query += "refresh" to "1"
        return send("GET", "/machines/$machineId/models", query = query)
    }

    // MARK: Machines / projects

    suspend fun listMachines(includeArchived: Boolean = false): List<MachineDTO> =
        send("GET", "/machines", query = flag("includeArchived", includeArchived))

    suspend fun deleteMachine(id: String) = sendVoid("DELETE", "/machines/$id")

    /** Current vs latest sidecar release for one machine. */
    suspend fun getSidecarVersion(machineId: String): SidecarVersionInfo =
        send("GET", "/machines/$machineId/sidecar/version")

    /**
     * Remote self-update (202; completion arrives as machine:upsert
     * with the new version once the sidecar re-registers).
     */
    suspend fun updateSidecar(machineId: String): SidecarUpdateAccepted =
        send("POST", "/machines/$machineId/sidecar/update")

    suspend fun listProjects(): List<ProjectDTO> = send("GET", "/projects")

    // MARK: Terminals (interactive PTY)

    /**
     * Open a PTY in the project's working dir — a terminal is a
     * (machine, cwd) pair. Rejected when the project has terminals
     * disabled, its machine is offline, or the sidecar link is down.
     */
    suspend fun openProjectTerminal(
        projectId: String,
        shell: String? = null,
        cwd: String? = null,
        cols: Int? = null,
        rows: Int? = null,
    ): TerminalDTO = send(
        "POST", "/projects/$projectId/terminals",
        body = json(OpenTerminalRequest(shell = shell, cwd = cwd, cols = cols, rows = rows)),
    )

    // MARK: Files / git (inspector data)

    suspend fun listProjectDir(
        projectId: String,
        path: String = "",
        showAll: Boolean = false,
        depth: Int? = null,
    ): FSListResponse {
        val query = mutableListOf<Pair<String, String>>()
        if (path.isNotEmpty()) query += "path" to path
        if (showAll) query += "showAll" to "true"
        if (depth != null && depth > 1) query += "depth" to depth.toString()
        return send("GET", "/projects/$projectId/fs/list", query = query)
    }

    suspend fun readProjectFile(projectId: String, path: String): FSReadResponse =
        send("GET", "/projects/$projectId/fs/read", query = listOf("path" to path))

    suspend fun getProjectGitLog(projectId: String, limit: Int? = null): GitLogResponse {
        val query = mutableListOf<Pair<String, String>>()
        if (limit != null && limit > 0) query += "limit" to limit.toString()
        return send("GET", "/projects/$projectId/git/log", query = query)
    }

    // MARK: /me views

    suspend fun getMyUsage(): WindowedUsage = send<UserUsageResponse>("GET", "/me/usage").usage

    suspend fun getMyActivity(): List<ActivityDay> = send<UserActivityResponse>("GET", "/me/activity").days

    suspend fun getMyQuota(): List<UserQuotaRow> = send<UserQuotaResponse>("GET", "/me/quota").quotas

    /**
     * The server's public Firebase client identifiers. Throws [ApiError]
     * with status 404 when the server has no Android push configured.
     */
    suspend fun getPushConfig(): PushConfigDTO = send("GET", "/me/push/config")

    /**
     * Register (or refresh) this device's push token — idempotent, so
     * call on every launch while push is enabled. The server validates
     * the token per [platform] (`android` is the FCM alphabet).
     */
    suspend fun registerDevice(token: String, platform: String = "android"): DeviceDTO =
        send("POST", "/me/devices", body = json(RegisterDeviceRequest(token = token, platform = platform)))

    /** Fire-and-forget on logout / push-disable (204 even for unknown tokens). */
    suspend fun unregisterDevice(token: String) = sendVoid("DELETE", "/me/devices/$token")

    suspend fun getMyExtensions(): UserExtensions = send("GET", "/me/extensions")

    suspend fun setMyExtensions(extensions: UserExtensions): UserExtensions =
        send("PUT", "/me/extensions", body = json(extensions))

    /**
     * Per-project scratchpad (Notes extension). Personal: never synced
     * to sidecars, keyed by the (machineId, workingDir) project pair.
     */
    suspend fun getProjectNotes(machineId: String, workingDir: String): String =
        send<ProjectNotesResponse>(
            "GET", "/me/project-notes",
            query = listOf("machineId" to machineId, "workingDir" to workingDir),
        ).notes

    suspend fun setProjectNotes(machineId: String, workingDir: String, notes: String): String =
        send<ProjectNotesResponse>(
            "PUT", "/me/project-notes",
            query = listOf("machineId" to machineId, "workingDir" to workingDir),
            body = json(ProjectNotesResponse(notes)),
        ).notes

    // MARK: Core

    @Serializable
    private data class ForkRequest(val commandId: String, val title: String? = null)

    @Serializable
    private data class OpenTerminalRequest(
        val shell: String? = null,
        val cwd: String? = null,
        val cols: Int? = null,
        val rows: Int? = null,
    )

    @Serializable
    private data class RegisterDeviceRequest(val token: String, val platform: String)

    private inline fun <reified B> json(body: B): String = ArgusJson.encodeToString(body)

    private fun flag(name: String, on: Boolean): List<Pair<String, String>> =
        if (on) listOf(name to "true") else emptyList()

    private fun buildRequest(
        method: String,
        path: String,
        query: List<Pair<String, String>>,
        body: RequestBody?,
    ): Request {
        // String concat, not URL resolution — resolving a leading-slash
        // path against a base with a path prefix would drop the prefix.
        val url = (baseUrl + path).toHttpUrlOrNull()
            ?: throw ApiError(0, "Invalid URL for path $path")
        val urlBuilder = url.newBuilder()
        for ((name, value) in query) urlBuilder.addQueryParameter(name, value)

        // OkHttp refuses a body-less POST/PUT/PATCH; the API has several
        // (archive, seen, cancel, sidecar update), so send an empty one.
        val requestBody = body
            ?: if (method in BODY_METHODS) ByteArray(0).toRequestBody(null) else null

        val builder = Request.Builder().url(urlBuilder.build()).method(method, requestBody)
        tokenProvider()?.let { builder.header("Authorization", "Bearer $it") }
        return builder.build()
    }

    private suspend fun perform(client: OkHttpClient, request: Request): String {
        val response = client.newCall(request).await()
        response.use { res ->
            val text = res.body?.string() ?: ""
            if (!res.isSuccessful) throw ApiError.from(res.code, text)
            return text
        }
    }

    private inline fun <reified T> decode(text: String): T = ArgusJson.decodeFromString<T>(text)

    private suspend inline fun <reified T> send(
        method: String,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: String? = null,
        client: OkHttpClient = http,
    ): T {
        val requestBody = body?.toRequestBody(JSON_MEDIA_TYPE)
        val request = buildRequest(method, path, query, requestBody)
        return decode(perform(client, request))
    }

    private suspend fun sendVoid(method: String, path: String) {
        perform(http, buildRequest(method, path, emptyList(), null))
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!continuation.isCancelled) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response)
            }
        })
        continuation.invokeOnCancellation { cancel() }
    }

    companion object {
        /** Comfortably above the server's 15 s fork hold. */
        const val FORK_READ_TIMEOUT_SECONDS: Long = 30

        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaTypeOrNull()
        private val BODY_METHODS = setOf("POST", "PUT", "PATCH")
    }
}
