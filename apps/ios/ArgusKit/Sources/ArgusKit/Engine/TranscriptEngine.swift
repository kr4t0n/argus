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

/// One rendered row in a turn's activity timeline. Tool results are
/// PAIRED into the tool row (like the web's ToolPill): a stdout/stderr
/// chunk keyed by `meta.toolResultFor` becomes the tool's `resultText` /
/// `isError` / `isDiff` rather than a standalone row.
public struct TimelineItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// A tool invocation, with its paired result folded in.
        case tool
        /// stdout/stderr NOT consumed by a shown tool.
        case output
        /// Assistant narration between tools (coalesced intermediate
        /// deltas) — interleaved chronologically, like the web's
        /// "thought" rows. Distinct from the final answer.
        case thought
        case thinking(redacted: Bool)
        /// Compaction divider (manual /compact or threshold auto) —
        /// everything above it was replaced by a summary.
        case compact
        /// The injected compaction summary — what future turns actually
        /// know about the compacted past. Rendered collapsed.
        case compactSummary
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
    /// This chunk's own content (the tool's label line, or the output/
    /// system/thinking/error text).
    public let text: String
    /// Lowercased-agnostic tool name (`meta.tool`), for `.tool` rows.
    public let toolName: String?
    /// Raw tool input (`meta.input`), for the expandable "show input".
    public let toolInput: [String: JSONValue]?
    /// Paired result body for a `.tool` row (stdout/stderr or a diff);
    /// nil when the tool produced no captured result.
    public let resultText: String?
    /// The (paired result, or this output) came from stderr.
    public let isError: Bool
    /// The result/output body is a unified diff (`meta.isDiff`).
    public let isDiff: Bool
    public let filePath: String?
    /// Process exit code from a paired/own stdout|stderr (`meta.exitCode`).
    public let exitCode: Int?

    public init(
        id: String,
        kind: Kind,
        seq: Int,
        text: String,
        toolName: String? = nil,
        toolInput: [String: JSONValue]? = nil,
        resultText: String? = nil,
        isError: Bool = false,
        isDiff: Bool = false,
        filePath: String? = nil,
        exitCode: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.seq = seq
        self.text = text
        self.toolName = toolName
        self.toolInput = toolInput
        self.resultText = resultText
        self.isError = isError
        self.isDiff = isDiff
        self.filePath = filePath
        self.exitCode = exitCode
    }

    /// Diff body for the DiffPanel / DiffText — the paired result when
    /// this row is a diff, falling back to `text`.
    public var diffBody: String { resultText ?? text }
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
    /// Latest to-do snapshot (TodoWindow), nil when the turn has none.
    public let todos: [TodoItem]?
    /// Sub-agent invocations (SubAgentWindow), empty when none.
    public let subAgents: [SubAgentCall]
    /// Files the agent touched this turn (FileChips), first-seen order.
    public let touchedFiles: [String]
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
            var merged = command
            // Preserve attachments across hot-path updates: the finalize/
            // cancel `command:updated` events carry a CommandDTO WITHOUT
            // `attachments` (bare CommandService.toDto server-side) —
            // only creation and transcript loads are the source of truth
            // for them. Without this merge a status flip wipes the
            // turn's thumbnails. The web has the identical merge in
            // sessionStore.upsertCommand.
            if merged.attachments?.isEmpty ?? true,
               let existing = commands[index].attachments,
               !existing.isEmpty {
                merged.attachments = existing
            }
            commands[index] = merged
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
            let chunks = chunksByCommand[command.id] ?? []
            // A compact_boundary carries the post-compaction context in
            // meta.postTokens — the compact turn's own final reports
            // zero usage, so the boundary IS that turn's context
            // signal. The later of (usage-bearing final, boundary) wins
            // — web useSessionContext parity.
            let boundary = chunks.last(where: {
                $0.kind == .progress
                    && $0.meta?["contentType"]?.string == "compact_boundary"
                    && $0.meta?["postTokens"]?.int != nil
            })
            let final = chunks.last(where: { $0.kind == .final })
            let finalUsage = final.flatMap {
                UsageParser.parseContextUsage(adapterType: agentType, meta: $0.meta)
            }
            var used: Int?
            if let boundary, let post = boundary.meta?["postTokens"]?.int,
               finalUsage == nil || boundary.seq > (final?.seq ?? -1) {
                used = Int(post)
            } else if let usage = finalUsage {
                used = Int(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
            }
            guard let used, used > 0 else { continue }
            let model = latestModel()
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

        // "Live turn text folds into the activity pill" (web parity, commit
        // 0ca1129). While a turn is still running, the trailing deltas
        // can't be classified yet — preamble if a tool follows, or the
        // final answer if it ends. So we fold ALL streaming text into the
        // timeline as thoughts and keep `answer` empty until the turn
        // settles; the text is in the pill from the first token and never
        // relocates when a tool lands (no flash). Once done, the trailing
        // deltas drop out of the timeline into the answer body.
        let turnDone = command.status.isTerminal
            || chunks.contains { $0.kind == .final || $0.kind == .error }

        var answer = turnDone ? split.finalDeltas.compactMap(\.delta).joined() : ""
        let narration = split.intermediateDeltas.compactMap(\.delta).joined()

        // Dedicated panels (todos, sub-agents) render separately and are
        // excluded from the main timeline below.
        let todos = DedicatedPanels.extractTodos(chunks)
        let subAgents = DedicatedPanels.extractSubAgents(chunks)
        let touchedFiles = FileReferences.extractFiles(chunks)

        // Pass 1: index NON-nested stdout/stderr results by the tool_use
        // id they answer, so a tool row can fold in its output/diff (web
        // parity — ActivityPill's resultByToolId skips sub-agent results).
        var resultByToolId: [String: ResultChunk] = [:]
        for chunk in chunks
        where (chunk.kind == .stdout || chunk.kind == .stderr) && !DedicatedPanels.isNested(chunk) {
            if let toolId = chunk.meta?["toolResultFor"]?.string {
                resultByToolId[toolId] = chunk
            }
        }
        var consumedResultIds = Set<String>()

        var timeline: [TimelineItem] = []
        var errorText: String?
        var usage: TokenUsage?
        var thinkingTokens: Int?
        var model: String?

        // Coalesce adjacent intermediate deltas (seq <= boundary) into a
        // "thought" run, flushed as one row right before the next
        // non-delta chunk — so narration interleaves chronologically
        // with the tools instead of collapsing into one block. Deltas
        // past the boundary are the final answer, not thoughts.
        var thoughtBuffer = ""
        var thoughtStart: (id: String, seq: Int)?
        func flushThought() {
            defer { thoughtBuffer = ""; thoughtStart = nil }
            guard let start = thoughtStart,
                  !thoughtBuffer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return }
            timeline.append(TimelineItem(
                id: start.id + ":thought", kind: .thought, seq: start.seq, text: thoughtBuffer
            ))
        }

        for chunk in chunks {
            if model == nil, let found = UsageParser.parseModel(meta: chunk.meta) {
                model = found
            }
            if chunk.kind == .delta {
                // Nested sub-agent text (preamble narration + streamed
                // response) is SubAgentWindow's concern, like nested
                // tools/thinking — the parent timeline must not absorb
                // it as its own thought.
                if DedicatedPanels.isNested(chunk) { continue }
                // Settled: only pre-boundary deltas are thoughts (trailing
                // ones are the answer). Live: fold every delta in as a
                // thought so nothing streams in the body then relocates.
                if !turnDone || chunk.seq <= split.boundarySeq {
                    if thoughtStart == nil { thoughtStart = (chunk.id, chunk.seq) }
                    thoughtBuffer += chunk.delta ?? ""
                }
                continue
            }
            // Any non-delta closes the current thought run.
            flushThought()

            switch chunk.kind {
            case .delta:
                continue

            case .tool:
                // Sub-agent inner tools render in SubAgentWindow only.
                if DedicatedPanels.isNested(chunk) { continue }
                let toolId = chunk.meta?["id"]?.string
                // Todo/agent/task tools render in their dedicated panels —
                // still consume their paired result so it doesn't orphan.
                if DedicatedPanels.isDedicatedPanelTool(chunk) {
                    if let toolId, let result = resultByToolId[toolId] {
                        consumedResultIds.insert(result.id)
                    }
                    continue
                }
                if let toolId, let result = resultByToolId[toolId] {
                    consumedResultIds.insert(result.id)
                }
                timeline.append(DedicatedPanels.toolItem(for: chunk, resultByToolId: resultByToolId))

            case .stdout, .stderr:
                // Sub-agent output belongs to SubAgentWindow, not here.
                if DedicatedPanels.isNested(chunk) { continue }
                // Standalone output only — a result already folded into a
                // tool row is skipped.
                if consumedResultIds.contains(chunk.id) { continue }
                timeline.append(TimelineItem(
                    id: chunk.id,
                    kind: .output,
                    seq: chunk.seq,
                    text: chunk.content ?? "",
                    isError: chunk.kind == .stderr,
                    isDiff: chunk.meta?["isDiff"]?.bool ?? false,
                    filePath: chunk.meta?["filePath"]?.string,
                    exitCode: chunk.meta?["exitCode"]?.int
                ))

            case .progress:
                // Sub-agent progress/thinking is SubAgentWindow's concern.
                if DedicatedPanels.isNested(chunk) { continue }
                let contentType = chunk.meta?["contentType"]?.string
                if contentType == "thinking" {
                    let redacted = chunk.meta?["redacted"]?.bool ?? false
                    let text = (chunk.content ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    // Models with display:"omitted" thinking send empty
                    // blocks (signature only) — expected, render nothing.
                    if !text.isEmpty {
                        timeline.append(TimelineItem(
                            id: chunk.id, kind: .thinking(redacted: redacted),
                            seq: chunk.seq, text: chunk.content ?? ""
                        ))
                    }
                    continue
                }
                if contentType == "thinking_tokens" {
                    if let estimated = chunk.meta?["estimatedTokens"]?.int {
                        thinkingTokens = max(thinkingTokens ?? 0, estimated)
                    }
                    continue
                }
                // Tool-narration progress (Claude's task_started
                // Compaction: the boundary renders as a transcript
                // divider, the injected summary as a collapsed row.
                // (Status pulses are content-less and fall through to
                // the silent branch below.)
                if contentType == "compact_boundary" {
                    timeline.append(TimelineItem(
                        id: chunk.id, kind: .compact, seq: chunk.seq,
                        text: chunk.content ?? "Compacted"
                    ))
                    continue
                }
                if contentType == "compact_summary" {
                    timeline.append(TimelineItem(
                        id: chunk.id, kind: .compactSummary, seq: chunk.seq,
                        text: chunk.content ?? ""
                    ))
                    continue
                }
                // `description`, tagged with tool_use_id) duplicates the
                // tool row — the web skips it (ActivityPill buildTimeline),
                // so drop it here too.
                if let toolUseId = chunk.meta?["tool_use_id"]?.string, !toolUseId.isEmpty {
                    continue
                }
                // Content-less progress (api_retry etc.) renders nothing;
                // content-ful unknown subtypes stay VISIBLE on purpose.
                if let content = chunk.content, !content.isEmpty {
                    timeline.append(TimelineItem(
                        id: chunk.id, kind: .system, seq: chunk.seq, text: content
                    ))
                }

            case .error:
                let text = chunk.content ?? "error"
                errorText = text
                timeline.append(TimelineItem(
                    id: chunk.id, kind: .error, seq: chunk.seq, text: text, isError: true
                ))

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
                    timeline.append(TimelineItem(
                        id: chunk.id, kind: .system, seq: chunk.seq, text: content
                    ))
                }
            }
        }
        flushThought()

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
            errorText: errorText,
            todos: todos,
            subAgents: subAgents,
            touchedFiles: touchedFiles
        )
    }
}
