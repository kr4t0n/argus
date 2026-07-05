import Foundation

// The transcript reducer — Swift counterpart of the web's
// `sessionStore` merge logic + `StreamViewer` grouping +
// `ActivityPill.buildTimeline`, as one pure, testable value type.
//
// Invariants mirrored from the web:
//   - chunks dedup by `id` (at-least-once delivery re-sends after server
//     restarts) and order by `seq` within their command;
//   - commands order by `createdAt` (then id, for stability);
//   - `maxSeq` is the session-wide high-water mark fed back into
//     `GET /sessions/:id/chunks?afterSeq=` on reconnect (seq resets per
//     command sidecar-side, so this is a heuristic that catches up the
//     currently-streaming turn; a full snapshot reload on app-foreground
//     is the robust path and Phase 1 does both).

/// One rendered row in a turn's activity timeline.
public struct TimelineItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case tool(name: String)
        case stdout
        case stderr
        case progress
        case thinking(redacted: Bool)
        /// Unknown system subtype — deliberately VISIBLE (project
        /// convention: the junk row is the breadcrumb that a new CLI
        /// event shape appeared).
        case system
        case error
    }

    /// Chunk id.
    public let id: String
    public let kind: Kind
    public let seq: Int
    public let text: String
    /// For tool chunks: the tool_use id (meta.id) other chunks pair on.
    public let toolUseId: String?
    /// For stdout/stderr: the tool_use id this output belongs to.
    public let toolResultFor: String?
    /// Unified-diff outputs (meta.isDiff) — render with a diff view.
    public let isDiff: Bool
    public let filePath: String?
}

/// One user turn: prompt + activity + answer, derived per command.
public struct Turn: Identifiable, Equatable, Sendable {
    /// Command id.
    public let id: String
    public let command: CommandDTO
    public let prompt: String
    public let status: CommandStatus
    public let isRunning: Bool
    /// Final assistant answer (markdown): final deltas joined, falling
    /// back to the `final` chunk's content when the CLI emitted no
    /// post-tool deltas.
    public let answer: String
    /// Interim narration (deltas before the last tool), joined.
    public let narration: String
    public let timeline: [TimelineItem]
    public let attachments: [AttachmentDTO]
    /// Per-turn totals from the final chunk (cost/usage semantics).
    public let usage: TokenUsage?
    /// Running "thinking tokens" counter (max estimated_tokens seen).
    public let thinkingTokens: Int?
    public let model: String?
    public let errorText: String?
}

/// Session-header context ring inputs: live context of the latest
/// completed turn vs the model's window.
public struct ContextSnapshot: Equatable, Sendable {
    public let model: String?
    /// input + cacheRead + cacheWrite of the latest single API call.
    public let usedTokens: Int
    public let windowInfo: ContextWindowInfo?

    /// 0…1, nil when the model isn't in the window table (hide the ring).
    public var fraction: Double? {
        guard let windowInfo, windowInfo.window > 0 else { return nil }
        return min(1, Double(usedTokens) / Double(windowInfo.window))
    }
}

public struct TranscriptState: Equatable, Sendable {
    public let sessionId: String
    public private(set) var commands: [CommandDTO] = []
    public private(set) var chunksByCommand: [String: [ResultChunk]] = [:]
    public private(set) var hasMoreHistory = false
    /// Session-wide seq high-water mark for afterSeq backfill.
    public private(set) var maxSeq = 0
    private var seenChunkIds: Set<String> = []

    public init(sessionId: String) {
        self.sessionId = sessionId
    }

    // MARK: Ingest

    /// Replace everything with a fresh snapshot (initial load, foreground
    /// reload). This is the robust catch-up path.
    public mutating func applySnapshot(commands: [CommandDTO], chunks: [ResultChunk], hasMore: Bool) {
        self.commands = []
        self.chunksByCommand = [:]
        self.seenChunkIds = []
        self.maxSeq = 0
        self.hasMoreHistory = hasMore
        merge(commands: commands, chunks: chunks)
    }

    /// Merge older turns fetched via `/history?before=` (scroll-up).
    public mutating func mergeOlder(commands: [CommandDTO], chunks: [ResultChunk], hasMore: Bool) {
        hasMoreHistory = hasMore
        merge(commands: commands, chunks: chunks)
    }

    /// Merge an afterSeq backfill response (reconnect catch-up).
    public mutating func mergeBackfill(commands: [CommandDTO], chunks: [ResultChunk]) {
        merge(commands: commands, chunks: chunks)
    }

    public mutating func upsert(command: CommandDTO) {
        guard command.sessionId == sessionId else { return }
        if let index = commands.firstIndex(where: { $0.id == command.id }) {
            commands[index] = command
        } else {
            commands.append(command)
            sortCommands()
        }
    }

    /// Append one live chunk. Returns false for duplicates / foreign
    /// sessions (safe to call with every socket event). REST-served
    /// chunks carry no sessionId (the route implies it) — those are
    /// trusted; WS chunks carry one and are checked.
    @discardableResult
    public mutating func append(chunk: ResultChunk) -> Bool {
        if let chunkSession = chunk.sessionId, chunkSession != sessionId { return false }
        guard !seenChunkIds.contains(chunk.id) else { return false }
        seenChunkIds.insert(chunk.id)
        insertSorted(chunk)
        maxSeq = max(maxSeq, chunk.seq)
        return true
    }

    private mutating func merge(commands newCommands: [CommandDTO], chunks newChunks: [ResultChunk]) {
        for command in newCommands { upsert(command: command) }
        for chunk in newChunks { append(chunk: chunk) }
    }

    private mutating func sortCommands() {
        commands.sort {
            $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
        }
    }

    private mutating func insertSorted(_ chunk: ResultChunk) {
        var list = chunksByCommand[chunk.commandId] ?? []
        // Chunks arrive almost always in order — scan from the tail.
        var index = list.endIndex
        while index > list.startIndex, list[list.index(before: index)].seq > chunk.seq {
            index = list.index(before: index)
        }
        list.insert(chunk, at: index)
        chunksByCommand[chunk.commandId] = list
    }

    // MARK: Derived

    /// Any turn still streaming? Drives composer send-vs-queue state.
    public var isRunning: Bool {
        commands.contains { $0.kind == .execute && !$0.status.isTerminal }
    }

    /// Cursor for `/history?before=` pagination.
    public var oldestCommandId: String? {
        commands.first?.id
    }

    /// Build display turns. `agentType` keys the usage parser.
    public func turns(agentType: AgentType) -> [Turn] {
        commands
            .filter { $0.kind == .execute }
            .map { buildTurn(command: $0, agentType: agentType) }
    }

    /// Context-ring inputs from the most recent turn that has a final
    /// chunk with parseable usage. Each CLI re-sends full history on
    /// resume, so the latest turn IS the live context.
    public func contextSnapshot(agentType: AgentType) -> ContextSnapshot? {
        for command in commands.reversed() {
            guard let final = (chunksByCommand[command.id] ?? [])
                .last(where: { $0.kind == .final })
            else { continue }
            guard let usage = UsageParser.parseContextUsage(
                adapterType: agentType, meta: final.meta
            ) else { continue }
            let model = latestModel()
            let used = Int(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
            return ContextSnapshot(
                model: model,
                usedTokens: used,
                windowInfo: ContextWindows.lookup(model: model)
            )
        }
        return nil
    }

    /// Cumulative session usage (the header badge's ↑/↓ totals).
    public func totalUsage(agentType: AgentType) -> TokenUsage? {
        var total: TokenUsage?
        for command in commands {
            for chunk in chunksByCommand[command.id] ?? [] where chunk.kind == .final {
                if let usage = UsageParser.parseUsage(adapterType: agentType, meta: chunk.meta) {
                    total = (total ?? .zero).adding(usage)
                }
            }
        }
        return total
    }

    /// Latest model any chunk advertised (newest command first).
    public func latestModel() -> String? {
        for command in commands.reversed() {
            for chunk in (chunksByCommand[command.id] ?? []).reversed() {
                if let model = UsageParser.parseModel(meta: chunk.meta) { return model }
            }
        }
        return nil
    }

    // MARK: Turn building

    private func buildTurn(command: CommandDTO, agentType: AgentType) -> Turn {
        let chunks = chunksByCommand[command.id] ?? []
        let split = DeltaSplit.split(chunks)

        var answer = split.finalDeltas.compactMap(\.delta).joined()
        let narration = split.intermediateDeltas.compactMap(\.delta).joined()

        var timeline: [TimelineItem] = []
        var errorText: String?
        var usage: TokenUsage?
        var thinkingTokens: Int?
        var model: String?

        for chunk in chunks {
            if model == nil, let found = UsageParser.parseModel(meta: chunk.meta) {
                model = found
            }
            switch chunk.kind {
            case .delta:
                continue

            case .tool:
                let name = chunk.meta?["tool"]?.string
                    ?? firstLine(of: chunk.content) ?? "tool"
                timeline.append(item(for: chunk, kind: .tool(name: name)))

            case .stdout:
                timeline.append(item(for: chunk, kind: .stdout))

            case .stderr:
                timeline.append(item(for: chunk, kind: .stderr))

            case .progress:
                let contentType = chunk.meta?["contentType"]?.string
                if contentType == "thinking" {
                    let redacted = chunk.meta?["redacted"]?.bool ?? false
                    let text = (chunk.content ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    // Models with display:"omitted" thinking send empty
                    // blocks (signature only) — expected, render nothing.
                    if !text.isEmpty {
                        timeline.append(item(for: chunk, kind: .thinking(redacted: redacted)))
                    }
                    continue
                }
                if contentType == "thinking_tokens" {
                    if let estimated = chunk.meta?["estimatedTokens"]?.int {
                        thinkingTokens = max(thinkingTokens ?? 0, estimated)
                    }
                    continue
                }
                // Content-less progress (api_retry etc.) renders nothing;
                // content-ful unknown subtypes stay VISIBLE on purpose.
                if let content = chunk.content, !content.isEmpty {
                    timeline.append(item(for: chunk, kind: .system))
                }

            case .error:
                let text = chunk.content ?? "error"
                errorText = text
                timeline.append(item(for: chunk, kind: .error))

            case .final:
                if usage == nil {
                    usage = UsageParser.parseUsage(adapterType: agentType, meta: chunk.meta)
                }
                // Fallback body: some flows emit the canonical answer only
                // on the final chunk (no post-tool deltas).
                if answer.isEmpty, let content = chunk.content, !content.isEmpty {
                    answer = content
                }

            case .unknown:
                if let content = chunk.content, !content.isEmpty {
                    timeline.append(item(for: chunk, kind: .system))
                }
            }
        }

        return Turn(
            id: command.id,
            command: command,
            prompt: command.prompt ?? "",
            status: command.status,
            isRunning: !command.status.isTerminal,
            answer: answer,
            narration: narration,
            timeline: timeline,
            attachments: command.attachments ?? [],
            usage: usage,
            thinkingTokens: thinkingTokens,
            model: model,
            errorText: errorText
        )
    }

    private func item(for chunk: ResultChunk, kind: TimelineItem.Kind) -> TimelineItem {
        TimelineItem(
            id: chunk.id,
            kind: kind,
            seq: chunk.seq,
            text: chunk.content ?? "",
            toolUseId: chunk.meta?["id"]?.string,
            toolResultFor: chunk.meta?["toolResultFor"]?.string,
            isDiff: chunk.meta?["isDiff"]?.bool ?? false,
            filePath: chunk.meta?["filePath"]?.string
        )
    }

    private func firstLine(of text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.split(separator: "\n", maxSplits: 1).first.map(String.init)
    }
}
