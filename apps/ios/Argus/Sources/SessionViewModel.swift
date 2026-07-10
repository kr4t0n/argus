import Foundation
import Observation
import ArgusKit

/// Per-open-session state: the TranscriptState reducer plus room
/// membership, send/cancel, history pagination, and the reconnect /
/// foreground catch-up paths. AppModel routes live socket events here
/// while this session is on screen.
@MainActor
@Observable
final class SessionViewModel {
    enum LoadState {
        case loading
        case loaded
        case failed(String)
    }

    let sessionId: String
    let agentType: AgentType

    private(set) var loadState: LoadState = .loading
    private(set) var turns: [Turn] = []
    private(set) var isRunning = false
    private(set) var hasMoreHistory = false
    private(set) var loadingOlder = false
    /// Cumulative session usage (header badge ↑/↓ totals).
    private(set) var usage: TokenUsage?
    /// Latest-turn live context vs the model window (donut ring).
    private(set) var context: ContextSnapshot?
    /// Transient send/cancel failure surfaced above the composer.
    var actionError: String?

    private var transcript: TranscriptState
    private let client: ArgusClient
    private let stream: StreamClient
    private let onAuthError: (Error) -> Void

    private var rebuildScheduled = false

    /// Initial-load page size — matches the web's DEFAULT_TAIL.
    /// Deliberately small: open cost scales with chunks per turn, not
    /// turn count; loadOlder pages the rest in on demand.
    private static let tailWindow = 4

    init(
        sessionId: String,
        agentType: AgentType,
        client: ArgusClient,
        stream: StreamClient,
        onAuthError: @escaping (Error) -> Void
    ) {
        self.sessionId = sessionId
        self.agentType = agentType
        self.client = client
        self.stream = stream
        self.onAuthError = onAuthError
        self.transcript = TranscriptState(sessionId: sessionId)
    }

    // MARK: Lifecycle

    /// Idempotent open — runs on every appearance, cold or cached
    /// (AppModel keeps view-models alive across session switches).
    /// Cold: full snapshot load behind the spinner. Cached: the view
    /// renders the existing transcript immediately and this refreshes
    /// it in place (stale-while-revalidate) — off-screen sessions leave
    /// their WS room, so anything that streamed while away was missed.
    func start() async {
        stream.joinSession(sessionId)
        if case .loaded = loadState {
            await revalidate()
        } else {
            await reloadSnapshot()
        }
        markSeen()
    }

    func stop() {
        stream.leaveSession(sessionId)
    }

    /// Full snapshot reload — the cold-load path. External callers go
    /// through start(), which picks this or the in-place revalidate.
    private func reloadSnapshot() async {
        do {
            let detail = try await client.getSession(id: sessionId, tailCommands: Self.tailWindow)
            transcript.applySnapshot(
                commands: detail.commands,
                chunks: detail.chunks,
                hasMore: detail.hasMore
            )
            loadState = .loaded
            rebuildNow()
        } catch {
            onAuthError(error)
            if case .loading = loadState {
                loadState = .failed((error as? APIError)?.message ?? error.localizedDescription)
            }
        }
    }

    /// Refresh a cached transcript without blanking it. When the fresh
    /// tail overlaps what we hold, MERGE it — command ids stay stable
    /// (no list jump) and older pages the user scrolled in survive.
    /// A disjoint window (> tailWindow turns landed while away) would
    /// leave a gap mid-transcript if merged, so that case falls back to
    /// the wipe-and-replace snapshot. `hasMoreHistory` is kept on the
    /// merge path: the response's flag describes its own 20-turn window,
    /// while the cached transcript may already reach further back.
    private func revalidate() async {
        do {
            let detail = try await client.getSession(id: sessionId, tailCommands: Self.tailWindow)
            let known = Set(transcript.commands.map(\.id))
            if detail.commands.contains(where: { known.contains($0.id) }) {
                transcript.mergeBackfill(commands: detail.commands, chunks: detail.chunks)
            } else {
                transcript.applySnapshot(
                    commands: detail.commands,
                    chunks: detail.chunks,
                    hasMore: detail.hasMore
                )
            }
            rebuildNow()
        } catch {
            // Keep showing the cached transcript; 401s still funnel out.
            onAuthError(error)
        }
    }

    func handleReconnect() async {
        stream.joinSession(sessionId)
        do {
            let missed = try await client.getSessionChunks(id: sessionId, afterSeq: transcript.maxSeq)
            transcript.mergeBackfill(commands: missed.commands, chunks: missed.chunks)
            rebuildNow()
        } catch {
            onAuthError(error)
        }
    }

    // MARK: Live ingest (called by AppModel's event pump)

    func ingestLive(chunk: ResultChunk) {
        guard chunk.sessionId == sessionId else { return }
        if transcript.append(chunk: chunk) {
            scheduleRebuild()
        }
    }

    func ingest(command: CommandDTO) {
        guard command.sessionId == sessionId else { return }
        transcript.upsert(command: command)
        scheduleRebuild()
    }

    func handleStatus(_ event: SessionStatusEvent) {
        guard event.id == sessionId else { return }
        // The turn just finished while we're looking at it — the web
        // suppresses the unread dot in exactly this case.
        if event.unread { markSeen() }
    }

    // MARK: Actions

    func send(_ text: String) async {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        actionError = nil
        do {
            let command = try await client.sendCommand(
                sessionId: sessionId,
                CreateCommandRequest(prompt: prompt)
            )
            transcript.upsert(command: command)
            rebuildNow()
        } catch {
            onAuthError(error)
            actionError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func cancelRunningTurn() async {
        guard let running = transcript.commands.last(where: {
            $0.kind == .execute && !$0.status.isTerminal
        }) else { return }
        do {
            let command = try await client.cancelCommand(id: running.id)
            transcript.upsert(command: command)
            rebuildNow()
        } catch {
            onAuthError(error)
            actionError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func loadOlder() async {
        guard hasMoreHistory, !loadingOlder, let before = transcript.oldestCommandId else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await client.getSessionHistory(id: sessionId, beforeCommandId: before)
            transcript.mergeOlder(commands: page.commands, chunks: page.chunks, hasMore: page.hasMore)
            rebuildNow()
        } catch {
            onAuthError(error)
        }
    }

    private func markSeen() {
        Task {
            try? await client.markSessionSeen(id: sessionId)
        }
    }

    // MARK: Turn derivation

    /// Deltas arrive many times per second; rebuilding (and re-parsing
    /// markdown) per chunk wastes main-thread time. Coalesce to ~12 Hz.
    private func scheduleRebuild() {
        guard !rebuildScheduled else { return }
        rebuildScheduled = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(80))
            rebuildScheduled = false
            rebuildNow()
        }
    }

    private func rebuildNow() {
        turns = transcript.turns(agentType: agentType)
        isRunning = transcript.isRunning
        hasMoreHistory = transcript.hasMoreHistory
        usage = transcript.totalUsage(agentType: agentType)
        context = transcript.contextSnapshot(agentType: agentType)
    }
}
