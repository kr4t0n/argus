import Foundation

/// Hand-written REST client — the Swift counterpart of
/// `apps/web/src/lib/api.ts`, which is the behavioral reference for every
/// endpoint here (paths, query params, envelopes).
///
/// Deliberately NOT generated: models decode tolerantly (unknown fields
/// ignored, open enums fall back) so server-side additions never break a
/// shipped build. When shared-types changes shape, update the mirror in
/// Models/ and refresh the test fixtures (`scripts/capture-ios-fixtures.sh`).
///
/// The JWT is held by the token provider closure — keep it in memory
/// (see `TokenStore`) and persist to Keychain separately; per-request
/// Keychain reads are a measurable cost.
public final class ArgusClient: @unchecked Sendable {
    public let baseURL: URL
    private let urlSession: URLSession
    private let tokenProvider: @Sendable () -> String?

    public init(
        baseURL: URL,
        tokenProvider: @escaping @Sendable () -> String?,
        urlSession: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.urlSession = urlSession
    }

    /// Absolutize an API-base-relative path (e.g. AttachmentDTO.url —
    /// those authenticate via their `?t=` token, not a header).
    public func absoluteURL(for path: String) -> URL? {
        URL(string: baseURL.absoluteString + path)
    }

    // MARK: Auth

    public func login(email: String, password: String) async throws -> LoginResponse {
        try await send("POST", "/auth/login", body: LoginRequest(email: email, password: password))
    }

    public func me() async throws -> AuthUser {
        let response: MeResponse = try await send("GET", "/auth/me")
        return response.user
    }

    // MARK: Sessions

    public func listSessions(includeArchived: Bool = false) async throws -> [SessionDTO] {
        try await send("GET", "/sessions", query: flag("includeArchived", includeArchived))
    }

    /// Initial load: last `tailCommands` turns (+ `hasMore` for scroll-up).
    public func getSession(id: String, tailCommands: Int? = nil) async throws -> SessionDetailResponse {
        var query: [URLQueryItem] = []
        if let tailCommands {
            query.append(URLQueryItem(name: "tailCommands", value: String(tailCommands)))
        }
        return try await send("GET", "/sessions/\(id)", query: query)
    }

    /// Reconnect backfill: every chunk with seq > afterSeq, plus commands.
    public func getSessionChunks(id: String, afterSeq: Int) async throws -> SessionChunksResponse {
        try await send(
            "GET", "/sessions/\(id)/chunks",
            query: [URLQueryItem(name: "afterSeq", value: String(afterSeq))]
        )
    }

    /// Scroll-up pagination: turns strictly older than `beforeCommandId`.
    public func getSessionHistory(
        id: String,
        beforeCommandId: String,
        limit: Int = 20
    ) async throws -> SessionHistoryResponse {
        try await send(
            "GET", "/sessions/\(id)/history",
            query: [
                URLQueryItem(name: "before", value: beforeCommandId),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
        )
    }

    public func createSession(_ request: CreateSessionRequest) async throws -> CreateSessionResponse {
        try await send("POST", "/sessions", body: request)
    }

    public func renameSession(id: String, title: String) async throws -> SessionDTO {
        try await send("PATCH", "/sessions/\(id)", body: ["title": title])
    }

    public func archiveSession(id: String) async throws -> SessionDTO {
        try await send("POST", "/sessions/\(id)/archive")
    }

    public func unarchiveSession(id: String) async throws -> SessionDTO {
        try await send("POST", "/sessions/\(id)/unarchive")
    }

    /// Clear the unread marker; no-op when already seen (fire-and-forget).
    @discardableResult
    public func markSessionSeen(id: String) async throws -> SessionDTO {
        try await send("POST", "/sessions/\(id)/seen")
    }

    public func forkSession(id: String, commandId: String, title: String? = nil) async throws -> SessionDTO {
        struct ForkRequest: Encodable {
            let commandId: String
            let title: String?
        }
        return try await send(
            "POST", "/sessions/\(id)/fork",
            body: ForkRequest(commandId: commandId, title: title)
        )
    }

    /// Replace the session-default model; nil clears to "CLI default".
    public func setSessionModel(id: String, modelSelection: ModelSelection?) async throws -> SessionDTO {
        try await send(
            "PATCH", "/sessions/\(id)/model",
            body: UpdateSessionModelRequest(modelSelection: modelSelection)
        )
    }

    // MARK: Commands

    public func sendCommand(sessionId: String, _ request: CreateCommandRequest) async throws -> CommandDTO {
        try await send("POST", "/sessions/\(sessionId)/commands", body: request)
    }

    public func cancelCommand(id: String) async throws -> CommandDTO {
        try await send("POST", "/commands/\(id)/cancel")
    }

    // MARK: Models

    /// Model catalog keyed (machineId, cliType) — catalogs belong to the
    /// machine's installed binary, so the picker can load one before any
    /// session of the type exists; `refresh` bypasses the server cache.
    public func getMachineModelCatalog(
        machineId: String,
        cliType: String,
        refresh: Bool = false
    ) async throws -> ModelCatalogResponse {
        var query = [URLQueryItem(name: "cliType", value: cliType)]
        if refresh { query.append(URLQueryItem(name: "refresh", value: "1")) }
        return try await send("GET", "/machines/\(machineId)/models", query: query)
    }

    // MARK: Machines / projects

    public func listMachines(includeArchived: Bool = false) async throws -> [MachineDTO] {
        try await send("GET", "/machines", query: flag("includeArchived", includeArchived))
    }

    // MARK: Terminals (interactive PTY)

    /// Open a PTY in the project's working dir — a terminal is a
    /// (machine, cwd) pair, so no agent is involved. Rejected when the
    /// project has terminals disabled, its machine is offline, or the
    /// sidecar link is down.
    public func openProjectTerminal(
        projectId: String,
        shell: String? = nil,
        cwd: String? = nil,
        cols: Int? = nil,
        rows: Int? = nil
    ) async throws -> TerminalDTO {
        struct Body: Encodable {
            let shell: String?
            let cwd: String?
            let cols: Int?
            let rows: Int?
        }
        return try await send(
            "POST", "/projects/\(projectId)/terminals",
            body: Body(shell: shell, cwd: cwd, cols: cols, rows: rows)
        )
    }

    public func deleteMachine(id: String) async throws {
        try await sendVoid("DELETE", "/machines/\(id)")
    }

    /// Current vs latest sidecar release for one machine.
    public func getSidecarVersion(machineId: String) async throws -> SidecarVersionInfo {
        try await send("GET", "/machines/\(machineId)/sidecar/version")
    }

    /// Remote self-update (202; completion arrives as machine:upsert
    /// with the new version once the sidecar re-registers).
    public func updateSidecar(machineId: String) async throws -> SidecarUpdateAccepted {
        try await send("POST", "/machines/\(machineId)/sidecar/update")
    }

    public func listProjects() async throws -> [ProjectDTO] {
        try await send("GET", "/projects")
    }

    // MARK: Files / git (right-pane data)

    // Project-addressed routes — the runner-era read path (the wire
    // request carries the workingDir; the sidecar serves it after an
    // allowlist check). The agent-addressed variants below stay for the
    // mixed-fleet window and die with Stage C.

    public func listProjectDir(
        projectId: String,
        path: String = "",
        showAll: Bool = false,
        depth: Int? = nil
    ) async throws -> FSListResponse {
        var query: [URLQueryItem] = []
        if !path.isEmpty { query.append(URLQueryItem(name: "path", value: path)) }
        if showAll { query.append(URLQueryItem(name: "showAll", value: "true")) }
        if let depth, depth > 1 { query.append(URLQueryItem(name: "depth", value: String(depth))) }
        return try await send("GET", "/projects/\(projectId)/fs/list", query: query)
    }

    public func readProjectFile(projectId: String, path: String) async throws -> FSReadResponse {
        try await send(
            "GET", "/projects/\(projectId)/fs/read",
            query: [URLQueryItem(name: "path", value: path)]
        )
    }

    public func getProjectGitLog(projectId: String, limit: Int? = nil) async throws -> GitLogResponse {
        var query: [URLQueryItem] = []
        if let limit, limit > 0 { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await send("GET", "/projects/\(projectId)/git/log", query: query)
    }

    // MARK: /me views

    public func getMyUsage() async throws -> WindowedUsage {
        let response: UserUsageResponse = try await send("GET", "/me/usage")
        return response.usage
    }

    public func getMyActivity() async throws -> [ActivityDay] {
        let response: UserActivityResponse = try await send("GET", "/me/activity")
        return response.days
    }

    public func getMyQuota() async throws -> [UserQuotaRow] {
        let response: UserQuotaResponse = try await send("GET", "/me/quota")
        return response.quotas
    }

    /// Register (or refresh) this device's APNs token — idempotent, so
    /// call on every launch while push is enabled.
    @discardableResult
    public func registerDevice(token: String, platform: String = "ios") async throws -> DeviceDTO {
        struct Body: Encodable {
            let token: String
            let platform: String
        }
        return try await send("POST", "/me/devices", body: Body(token: token, platform: platform))
    }

    /// Fire-and-forget on logout / push-disable (204 even for unknown tokens).
    public func unregisterDevice(token: String) async throws {
        try await sendVoid("DELETE", "/me/devices/\(token)")
    }

    /// Register a Live Activity's per-activity push token so the server
    /// can drive the lock-screen card while the app is backgrounded.
    @discardableResult
    public func registerLiveActivity(token: String, sessionId: String) async throws -> LiveActivityDTO {
        struct Body: Encodable {
            let token: String
            let sessionId: String
        }
        return try await send(
            "POST", "/me/live-activities",
            body: Body(token: token, sessionId: sessionId)
        )
    }

    /// Fire-and-forget when the activity ends (APNs 410 prunes strays).
    public func unregisterLiveActivity(token: String) async throws {
        try await sendVoid("DELETE", "/me/live-activities/\(token)")
    }

    public func getMyExtensions() async throws -> UserExtensions {
        try await send("GET", "/me/extensions")
    }

    public func setMyExtensions(_ extensions: UserExtensions) async throws -> UserExtensions {
        try await send("PUT", "/me/extensions", body: extensions)
    }

    /// Per-project scratchpad (Notes extension). Personal: never synced
    /// to sidecars, keyed by the (machineId, workingDir) project pair.
    public func getProjectNotes(machineId: String, workingDir: String) async throws -> String {
        struct Response: Decodable {
            let notes: String
        }
        let response: Response = try await send(
            "GET", "/me/project-notes",
            query: [
                URLQueryItem(name: "machineId", value: machineId),
                URLQueryItem(name: "workingDir", value: workingDir),
            ]
        )
        return response.notes
    }

    @discardableResult
    public func setProjectNotes(
        machineId: String,
        workingDir: String,
        notes: String
    ) async throws -> String {
        struct Body: Encodable {
            let notes: String
        }
        struct Response: Decodable {
            let notes: String
        }
        let response: Response = try await send(
            "PUT", "/me/project-notes",
            query: [
                URLQueryItem(name: "machineId", value: machineId),
                URLQueryItem(name: "workingDir", value: workingDir),
            ],
            body: Body(notes: notes)
        )
        return response.notes
    }

    /// Active + recently-ended background tasks (Progress extension) —
    /// hydrates the pane; `background-task:*` events keep it live.
    public func listBackgroundTasks(machineId: String, workingDir: String) async throws -> [BackgroundTaskDTO] {
        let response: BackgroundTasksResponse = try await send(
            "GET", "/machines/\(machineId)/background-tasks",
            query: [URLQueryItem(name: "workingDir", value: workingDir)]
        )
        return response.tasks
    }

    /// Global effect: every dashboard viewing the project drops the card.
    public func dismissBackgroundTask(machineId: String, workingDir: String, taskId: String) async throws {
        try await sendVoid(
            "DELETE", "/machines/\(machineId)/background-tasks/\(taskId)",
            query: [URLQueryItem(name: "workingDir", value: workingDir)]
        )
    }

    // MARK: Core

    private func flag(_ name: String, _ on: Bool) -> [URLQueryItem] {
        on ? [URLQueryItem(name: name, value: "true")] : []
    }

    private func makeRequest(
        _ method: String,
        _ path: String,
        query: [URLQueryItem],
        bodyData: Data?
    ) throws -> URLRequest {
        // String concat, not appendingPathComponent — the latter turns a
        // leading-slash path into "//sessions", which routers 404.
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard var components = URLComponents(string: base + path) else {
            throw APIError(status: 0, message: "Invalid URL for path \(path)")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else {
            throw APIError(status: 0, message: "Invalid URL for path \(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, message: "Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.from(status: http.statusCode, body: data)
        }
        return data
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        try JSONDecoder().decode(T.self, from: data)
    }

    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> T {
        let request = try makeRequest(method, path, query: query, bodyData: nil)
        return try decode(try await perform(request))
    }

    private func send<T: Decodable, B: Encodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: B
    ) async throws -> T {
        let bodyData = try JSONEncoder().encode(body)
        let request = try makeRequest(method, path, query: query, bodyData: bodyData)
        return try decode(try await perform(request))
    }

    private func sendVoid(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws {
        let request = try makeRequest(method, path, query: query, bodyData: nil)
        _ = try await perform(request)
    }

    func sendMultipart<T: Decodable>(
        path: String,
        contentType: String,
        body: Data
    ) async throws -> T {
        var request = try makeRequest("POST", path, query: [], bodyData: body)
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        return try decode(try await perform(request))
    }
}
