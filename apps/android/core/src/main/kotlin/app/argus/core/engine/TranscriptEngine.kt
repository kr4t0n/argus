package app.argus.core.engine

import app.argus.core.model.AgentType
import app.argus.core.model.AttachmentDTO
import app.argus.core.model.CommandDTO
import app.argus.core.model.CommandKind
import app.argus.core.model.CommandStatus
import app.argus.core.model.ResultChunk
import app.argus.core.model.ResultKind
import app.argus.core.model.TokenUsage
import app.argus.core.model.asBool
import app.argus.core.model.asInt
import app.argus.core.model.asString
import kotlinx.serialization.json.JsonObject

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/TranscriptEngine.swift.
//
// The transcript reducer — the Kotlin counterpart of the web's
// `sessionStore` merge logic (apps/web/src/stores/sessionStore.ts) +
// `StreamViewer` grouping (apps/web/src/components/StreamViewer.tsx) +
// `ActivityPill.buildTimeline`, as one pure, testable object.
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
//
// Depends on the sibling engine files DedicatedPanels.kt (`DedicatedPanels`,
// `TodoItem`, `SubAgentCall`) and FileReferences.kt (`FileReferences`) —
// the same split as ArgusKit.

/**
 * One rendered row in a turn's activity timeline. Tool results are
 * PAIRED into the tool row (like the web's ToolPill): a stdout/stderr
 * chunk keyed by `meta.toolResultFor` becomes the tool's [resultText] /
 * [isError] / [isDiff] rather than a standalone row.
 */
data class TimelineItem(
    /** Chunk id. */
    val id: String,
    val kind: Kind,
    val seq: Int,
    /**
     * This chunk's own content (the tool's label line, or the output/
     * system/thinking/error text).
     */
    val text: String,
    /** Lowercased-agnostic tool name (`meta.tool`), for [Kind.Tool] rows. */
    val toolName: String? = null,
    /** Raw tool input (`meta.input`), for the expandable "show input". */
    val toolInput: JsonObject? = null,
    /**
     * Paired result body for a [Kind.Tool] row (stdout/stderr or a diff);
     * null when the tool produced no captured result.
     */
    val resultText: String? = null,
    /** The (paired result, or this output) came from stderr. */
    val isError: Boolean = false,
    /** The result/output body is a unified diff (`meta.isDiff`). */
    val isDiff: Boolean = false,
    val filePath: String? = null,
    /** Process exit code from a paired/own stdout|stderr (`meta.exitCode`). */
    val exitCode: Int? = null,
) {
    sealed interface Kind {
        /** A tool invocation, with its paired result folded in. */
        data object Tool : Kind

        /** stdout/stderr NOT consumed by a shown tool. */
        data object Output : Kind

        /**
         * Assistant narration between tools (coalesced intermediate
         * deltas) — interleaved chronologically, like the web's
         * "thought" rows. Distinct from the final answer.
         */
        data object Thought : Kind

        data class Thinking(val redacted: Boolean) : Kind

        /**
         * Compaction divider (manual /compact or threshold auto) —
         * everything above it was replaced by a summary.
         */
        data object Compact : Kind

        /**
         * The injected compaction summary — what future turns actually
         * know about the compacted past. Rendered collapsed.
         */
        data object CompactSummary : Kind

        /**
         * Unknown system subtype — deliberately VISIBLE (project
         * convention: the junk row is the breadcrumb that a new CLI
         * event shape appeared).
         */
        data object System : Kind

        data object Error : Kind
    }

    /**
     * Diff body for the DiffPanel / DiffText — the paired result when
     * this row is a diff, falling back to [text].
     */
    val diffBody: String
        get() = resultText ?: text
}

/** One user turn: prompt + activity + answer, derived per command. */
data class Turn(
    /** Command id. */
    val id: String,
    val command: CommandDTO,
    val prompt: String,
    val status: CommandStatus,
    val isRunning: Boolean,
    /**
     * Final assistant answer (markdown): final deltas joined, falling
     * back to the `final` chunk's content when the CLI emitted no
     * post-tool deltas.
     */
    val answer: String,
    /** Interim narration (deltas before the last tool), joined. */
    val narration: String,
    val timeline: List<TimelineItem>,
    val attachments: List<AttachmentDTO>,
    /** Per-turn totals from the final chunk (cost/usage semantics). */
    val usage: TokenUsage?,
    /** Running "thinking tokens" counter (max estimated_tokens seen). */
    val thinkingTokens: Int?,
    val model: String?,
    val errorText: String?,
    /** Latest to-do snapshot (TodoWindow), null when the turn has none. */
    val todos: List<TodoItem>?,
    /** Sub-agent invocations (SubAgentWindow), empty when none. */
    val subAgents: List<SubAgentCall>,
    /** Files the agent touched this turn (FileChips), first-seen order. */
    val touchedFiles: List<String>,
)

/**
 * Session-header context ring inputs: live context of the latest
 * completed turn vs the model's window.
 */
data class ContextSnapshot(
    val model: String?,
    /** input + cacheRead + cacheWrite of the latest single API call. */
    val usedTokens: Int,
    val windowInfo: ContextWindowInfo?,
) {
    /** 0…1, null when the model isn't in the window table (hide the ring). */
    val fraction: Double?
        get() {
            val info = windowInfo ?: return null
            if (info.window <= 0) return null
            return minOf(1.0, usedTokens.toDouble() / info.window.toDouble())
        }
}

/**
 * The transcript of one session, as a mutable reducer. ArgusKit's
 * `TranscriptState` is a value type (a `struct` with mutating methods);
 * here it is a plain class with private mutable state and the same method
 * names, so the app port can follow ArgusKit 1:1. [commands] and
 * [chunksByCommand] are read-only LIVE views of that state, not snapshots
 * — derive what you need (e.g. [turns]) before mutating further.
 */
class TranscriptState(val sessionId: String) {
    private val mutableCommands = ArrayList<CommandDTO>()
    private val mutableChunksByCommand = HashMap<String, ArrayList<ResultChunk>>()
    private val seenChunkIds = HashSet<String>()

    val commands: List<CommandDTO>
        get() = mutableCommands

    val chunksByCommand: Map<String, List<ResultChunk>>
        get() = mutableChunksByCommand

    var hasMoreHistory: Boolean = false
        private set

    /** Session-wide seq high-water mark for afterSeq backfill. */
    var maxSeq: Int = 0
        private set

    // MARK: Ingest

    /**
     * Replace everything with a fresh snapshot (initial load, foreground
     * reload). This is the robust catch-up path.
     */
    fun applySnapshot(commands: List<CommandDTO>, chunks: List<ResultChunk>, hasMore: Boolean) {
        mutableCommands.clear()
        mutableChunksByCommand.clear()
        seenChunkIds.clear()
        maxSeq = 0
        hasMoreHistory = hasMore
        merge(commands, chunks)
    }

    /** Merge older turns fetched via `/history?before=` (scroll-up). */
    fun mergeOlder(commands: List<CommandDTO>, chunks: List<ResultChunk>, hasMore: Boolean) {
        hasMoreHistory = hasMore
        merge(commands, chunks)
    }

    /**
     * Merge an afterSeq backfill response (reconnect catch-up), filtered
     * to what the held window is entitled to. `GET /sessions/:id/chunks`
     * has no window parameters — it returns EVERY command in the session —
     * so a wholesale merge un-windowed a short tail into the whole history:
     * hundreds of turns landed ABOVE the viewport, contentless (their
     * chunks are filtered out by `afterSeq`), and the list jumped to the
     * top of the session. The rule is the web's `sessionStore.backfill`
     * (tail-window branch): a turn already held updates in place, a turn
     * strictly newer than the newest held one is accepted (created while
     * disconnected), everything older is dropped, and so are chunks whose
     * turn is outside the window. An empty transcript accepts everything:
     * there is no window to protect. [hasMoreHistory] is untouched because
     * the window's lower edge did not move. Same filter as ArgusKit's
     * `TranscriptState.mergeBackfill`.
     */
    fun mergeBackfill(commands: List<CommandDTO>, chunks: List<ResultChunk>) {
        val held = mutableCommands.mapTo(HashSet()) { it.id }
        val newest = mutableCommands.lastOrNull()?.createdAt
        val accepted = commands.filter { command ->
            command.id in held || newest == null || command.createdAt >= newest
        }
        val window = held + accepted.map { it.id }
        merge(accepted, chunks.filter { it.commandId in window })
    }

    fun upsert(command: CommandDTO) {
        if (command.sessionId != sessionId) return
        val index = mutableCommands.indexOfFirst { it.id == command.id }
        if (index >= 0) {
            var merged = command
            // Preserve attachments across hot-path updates: the finalize/
            // cancel `command:updated` events carry a CommandDTO WITHOUT
            // `attachments` (bare CommandService.toDto server-side) —
            // only creation and transcript loads are the source of truth
            // for them. Without this merge a status flip wipes the
            // turn's thumbnails. The web has the identical merge in
            // sessionStore.upsertCommand.
            val existing = mutableCommands[index].attachments
            if (merged.attachments.isNullOrEmpty() && !existing.isNullOrEmpty()) {
                merged = merged.copy(attachments = existing)
            }
            mutableCommands[index] = merged
        } else {
            mutableCommands.add(command)
            sortCommands()
        }
    }

    /**
     * Append one live chunk. Returns false for duplicates / foreign
     * sessions (safe to call with every socket event). REST-served
     * chunks carry no sessionId (the route implies it) — those are
     * trusted; WS chunks carry one and are checked.
     */
    fun append(chunk: ResultChunk): Boolean {
        val chunkSession = chunk.sessionId
        if (chunkSession != null && chunkSession != sessionId) return false
        if (!seenChunkIds.add(chunk.id)) return false
        insertSorted(chunk)
        maxSeq = maxOf(maxSeq, chunk.seq)
        return true
    }

    private fun merge(newCommands: List<CommandDTO>, newChunks: List<ResultChunk>) {
        for (command in newCommands) upsert(command)
        for (chunk in newChunks) append(chunk)
    }

    private fun sortCommands() {
        mutableCommands.sortWith(compareBy<CommandDTO> { it.createdAt }.thenBy { it.id })
    }

    private fun insertSorted(chunk: ResultChunk) {
        val list = mutableChunksByCommand.getOrPut(chunk.commandId) { ArrayList() }
        // Chunks arrive almost always in order — scan from the tail.
        var index = list.size
        while (index > 0 && list[index - 1].seq > chunk.seq) {
            index--
        }
        list.add(index, chunk)
    }

    // MARK: Derived

    /** Any turn still streaming? Drives composer send-vs-queue state. */
    val isRunning: Boolean
        get() = mutableCommands.any { it.kind == CommandKind.EXECUTE && !it.status.isTerminal }

    /** Cursor for `/history?before=` pagination. */
    val oldestCommandId: String?
        get() = mutableCommands.firstOrNull()?.id

    /** Build display turns. [agentType] keys the usage parser. */
    fun turns(agentType: AgentType): List<Turn> =
        mutableCommands
            .filter { it.kind == CommandKind.EXECUTE }
            .map { buildTurn(it, agentType) }

    /**
     * Context-ring inputs from the most recent turn that has a final
     * chunk with parseable usage. Each CLI re-sends full history on
     * resume, so the latest turn IS the live context.
     */
    fun contextSnapshot(agentType: AgentType): ContextSnapshot? {
        for (command in mutableCommands.asReversed()) {
            val chunks: List<ResultChunk> = mutableChunksByCommand[command.id] ?: emptyList()
            // A compact_boundary carries the post-compaction context in
            // meta.postTokens — the compact turn's own final reports
            // zero usage, so the boundary IS that turn's context
            // signal. The later of (usage-bearing final, boundary) wins
            // — web useSessionContext parity.
            val boundary = chunks.lastOrNull {
                it.kind == ResultKind.PROGRESS &&
                    it.meta?.get("contentType")?.asString == "compact_boundary" &&
                    it.meta?.get("postTokens")?.asInt != null
            }
            val finalChunk = chunks.lastOrNull { it.kind == ResultKind.FINAL }
            val finalUsage = finalChunk
                ?.let { UsageParser.parseContextUsage(agentType, it.meta) }
                // A cost-only parse — the compact turn's final: zero
                // tokens but a real total cost, which hasUsage counts —
                // carries no context signal; without this the compact
                // command is skipped and the ring shows the STALE
                // pre-compact size (web usage.ts keeps the same guard).
                ?.takeIf { (it.inputTokens + it.cacheReadTokens + it.cacheWriteTokens) > 0 }
            var used: Int? = null
            val post = boundary?.meta?.get("postTokens")?.asInt
            if (boundary != null && post != null &&
                (finalUsage == null || boundary.seq > (finalChunk?.seq ?: -1))
            ) {
                used = post
            } else if (finalUsage != null) {
                used = (finalUsage.inputTokens + finalUsage.cacheReadTokens + finalUsage.cacheWriteTokens).toInt()
            }
            if (used == null || used <= 0) continue
            val model = latestModel()
            // The window the turn itself reported, when the transport
            // supplies one (Codex app-server). Authoritative over any
            // name-keyed lookup: per-thread, and the usable ceiling rather
            // than the nominal one.
            val reported = chunks.lastOrNull {
                it.kind == ResultKind.FINAL && it.meta?.get("modelContextWindow")?.asInt != null
            }?.meta?.get("modelContextWindow")?.asInt
            return ContextSnapshot(
                model = model,
                usedTokens = used,
                windowInfo = ContextWindows.resolve(model = model, reportedWindow = reported),
            )
        }
        return null
    }

    /** Cumulative session usage (the header badge's ↑/↓ totals). */
    fun totalUsage(agentType: AgentType): TokenUsage? {
        var total: TokenUsage? = null
        for (command in mutableCommands) {
            for (chunk in mutableChunksByCommand[command.id] ?: emptyList<ResultChunk>()) {
                if (chunk.kind != ResultKind.FINAL) continue
                val usage = UsageParser.parseUsage(agentType, chunk.meta) ?: continue
                total = (total ?: TokenUsage.ZERO) + usage
            }
        }
        return total
    }

    /** Latest model any chunk advertised (newest command first). */
    fun latestModel(): String? {
        for (command in mutableCommands.asReversed()) {
            val chunks: List<ResultChunk> = mutableChunksByCommand[command.id] ?: emptyList()
            for (chunk in chunks.asReversed()) {
                val model = UsageParser.parseModel(chunk.meta)
                if (model != null) return model
            }
        }
        return null
    }

    // MARK: Turn building

    private fun buildTurn(command: CommandDTO, agentType: AgentType): Turn {
        val chunks: List<ResultChunk> = mutableChunksByCommand[command.id] ?: emptyList()
        val split = DeltaSplit.split(chunks)

        // "Live turn text folds into the activity pill" (web parity, commit
        // 0ca1129). While a turn is still running, the trailing deltas
        // can't be classified yet — preamble if a tool follows, or the
        // final answer if it ends. So we fold ALL streaming text into the
        // timeline as thoughts and keep `answer` empty until the turn
        // settles; the text is in the pill from the first token and never
        // relocates when a tool lands (no flash). Once done, the trailing
        // deltas drop out of the timeline into the answer body.
        val turnDone = command.status.isTerminal ||
            chunks.any { it.kind == ResultKind.FINAL || it.kind == ResultKind.ERROR }

        var answer = if (turnDone) split.finalDeltas.mapNotNull { it.delta }.joinToString("") else ""
        val narration = split.intermediateDeltas.mapNotNull { it.delta }.joinToString("")

        // Dedicated panels (todos, sub-agents) render separately and are
        // excluded from the main timeline below.
        val todos = DedicatedPanels.extractTodos(chunks)
        val subAgents = DedicatedPanels.extractSubAgents(chunks)
        val touchedFiles = FileReferences.extractFiles(chunks)

        // Pass 1: index NON-nested stdout/stderr results by the tool_use
        // id they answer, so a tool row can fold in its output/diff (web
        // parity — ActivityPill's resultByToolId skips sub-agent results).
        val resultByToolId = HashMap<String, ResultChunk>()
        for (chunk in chunks) {
            if ((chunk.kind == ResultKind.STDOUT || chunk.kind == ResultKind.STDERR) &&
                !DedicatedPanels.isNested(chunk)
            ) {
                val toolId = chunk.meta?.get("toolResultFor")?.asString
                if (toolId != null) resultByToolId[toolId] = chunk
            }
        }
        val consumedResultIds = HashSet<String>()

        val timeline = ArrayList<TimelineItem>()
        var errorText: String? = null
        var usage: TokenUsage? = null
        var thinkingTokens: Int? = null
        var model: String? = null

        // Coalesce adjacent intermediate deltas (seq <= boundary) into a
        // "thought" run, flushed as one row right before the next
        // non-delta chunk — so narration interleaves chronologically
        // with the tools instead of collapsing into one block. Deltas
        // past the boundary are the final answer, not thoughts.
        val thoughtBuffer = StringBuilder()
        var thoughtStartId: String? = null
        var thoughtStartSeq = 0
        fun flushThought() {
            val startId = thoughtStartId
            if (startId != null && thoughtBuffer.isNotBlank()) {
                timeline.add(
                    TimelineItem(
                        id = "$startId:thought",
                        kind = TimelineItem.Kind.Thought,
                        seq = thoughtStartSeq,
                        text = thoughtBuffer.toString(),
                    ),
                )
            }
            thoughtBuffer.setLength(0)
            thoughtStartId = null
        }

        for (chunk in chunks) {
            if (model == null) {
                val found = UsageParser.parseModel(chunk.meta)
                if (found != null) model = found
            }
            if (chunk.kind == ResultKind.DELTA) {
                // Nested sub-agent text (preamble narration + streamed
                // response) is SubAgentWindow's concern, like nested
                // tools/thinking — the parent timeline must not absorb
                // it as its own thought.
                if (DedicatedPanels.isNested(chunk)) continue
                // Settled: only pre-boundary deltas are thoughts (trailing
                // ones are the answer). Live: fold every delta in as a
                // thought so nothing streams in the body then relocates.
                if (!turnDone || chunk.seq <= split.boundarySeq) {
                    if (thoughtStartId == null) {
                        thoughtStartId = chunk.id
                        thoughtStartSeq = chunk.seq
                    }
                    thoughtBuffer.append(chunk.delta ?: "")
                }
                continue
            }
            // Any non-delta closes the current thought run.
            flushThought()

            when (chunk.kind) {
                ResultKind.DELTA -> Unit

                ResultKind.TOOL -> {
                    // Sub-agent inner tools render in SubAgentWindow only.
                    if (DedicatedPanels.isNested(chunk)) continue
                    val toolId = chunk.meta?.get("id")?.asString
                    // Todo/agent/task tools render in their dedicated panels —
                    // still consume their paired result so it doesn't orphan.
                    if (DedicatedPanels.isDedicatedPanelTool(chunk)) {
                        val result = toolId?.let { resultByToolId[it] }
                        if (result != null) consumedResultIds.add(result.id)
                        continue
                    }
                    val result = toolId?.let { resultByToolId[it] }
                    if (result != null) consumedResultIds.add(result.id)
                    timeline.add(DedicatedPanels.toolItem(chunk, resultByToolId))
                }

                ResultKind.STDOUT, ResultKind.STDERR -> {
                    // Sub-agent output belongs to SubAgentWindow, not here.
                    if (DedicatedPanels.isNested(chunk)) continue
                    // Standalone output only — a result already folded into a
                    // tool row is skipped.
                    if (chunk.id in consumedResultIds) continue
                    timeline.add(
                        TimelineItem(
                            id = chunk.id,
                            kind = TimelineItem.Kind.Output,
                            seq = chunk.seq,
                            text = chunk.content ?: "",
                            isError = chunk.kind == ResultKind.STDERR,
                            isDiff = chunk.meta?.get("isDiff")?.asBool ?: false,
                            filePath = chunk.meta?.get("filePath")?.asString,
                            exitCode = chunk.meta?.get("exitCode")?.asInt,
                        ),
                    )
                }

                ResultKind.PROGRESS -> {
                    // Sub-agent progress/thinking is SubAgentWindow's concern.
                    if (DedicatedPanels.isNested(chunk)) continue
                    val contentType = chunk.meta?.get("contentType")?.asString
                    if (contentType == "thinking") {
                        val redacted = chunk.meta?.get("redacted")?.asBool ?: false
                        val text = (chunk.content ?: "").trim()
                        // Models with display:"omitted" thinking send empty
                        // blocks (signature only) — expected, render nothing.
                        if (text.isNotEmpty()) {
                            timeline.add(
                                TimelineItem(
                                    id = chunk.id,
                                    kind = TimelineItem.Kind.Thinking(redacted = redacted),
                                    seq = chunk.seq,
                                    text = chunk.content ?: "",
                                ),
                            )
                        }
                        continue
                    }
                    if (contentType == "thinking_tokens") {
                        val estimated = chunk.meta?.get("estimatedTokens")?.asInt
                        if (estimated != null) {
                            thinkingTokens = maxOf(thinkingTokens ?: 0, estimated)
                        }
                        continue
                    }
                    // Tool-narration progress (Claude's task_started
                    // Compaction: the boundary renders as a transcript
                    // divider, the injected summary as a collapsed row.
                    // (Status pulses are content-less and fall through to
                    // the silent branch below.)
                    if (contentType == "compact_boundary") {
                        timeline.add(
                            TimelineItem(
                                id = chunk.id,
                                kind = TimelineItem.Kind.Compact,
                                seq = chunk.seq,
                                text = chunk.content ?: "Compacted",
                            ),
                        )
                        continue
                    }
                    if (contentType == "compact_summary") {
                        timeline.add(
                            TimelineItem(
                                id = chunk.id,
                                kind = TimelineItem.Kind.CompactSummary,
                                seq = chunk.seq,
                                text = chunk.content ?: "",
                            ),
                        )
                        continue
                    }
                    // `description`, tagged with tool_use_id) duplicates the
                    // tool row — the web skips it (ActivityPill buildTimeline),
                    // so drop it here too.
                    val toolUseId = chunk.meta?.get("tool_use_id")?.asString
                    if (!toolUseId.isNullOrEmpty()) continue
                    // Content-less progress (api_retry etc.) renders nothing;
                    // content-ful unknown subtypes stay VISIBLE on purpose.
                    val content = chunk.content
                    if (!content.isNullOrEmpty()) {
                        timeline.add(
                            TimelineItem(
                                id = chunk.id,
                                kind = TimelineItem.Kind.System,
                                seq = chunk.seq,
                                text = content,
                            ),
                        )
                    }
                }

                ResultKind.ERROR -> {
                    val text = chunk.content ?: "error"
                    errorText = text
                    timeline.add(
                        TimelineItem(
                            id = chunk.id,
                            kind = TimelineItem.Kind.Error,
                            seq = chunk.seq,
                            text = text,
                            isError = true,
                        ),
                    )
                }

                ResultKind.FINAL -> {
                    if (usage == null) {
                        usage = UsageParser.parseUsage(agentType, chunk.meta)
                    }
                    // Fallback body: some flows emit the canonical answer only
                    // on the final chunk (no post-tool deltas).
                    val content = chunk.content
                    if (answer.isEmpty() && !content.isNullOrEmpty()) {
                        answer = content
                    }
                }

                ResultKind.UNKNOWN -> {
                    val content = chunk.content
                    if (!content.isNullOrEmpty()) {
                        timeline.add(
                            TimelineItem(
                                id = chunk.id,
                                kind = TimelineItem.Kind.System,
                                seq = chunk.seq,
                                text = content,
                            ),
                        )
                    }
                }
            }
        }
        flushThought()

        return Turn(
            id = command.id,
            command = command,
            prompt = command.prompt ?: "",
            status = command.status,
            isRunning = !command.status.isTerminal,
            answer = answer,
            narration = narration,
            timeline = timeline,
            attachments = command.attachments ?: emptyList(),
            usage = usage,
            thinkingTokens = thinkingTokens,
            model = model,
            errorText = errorText,
            todos = todos,
            subAgents = subAgents,
            touchedFiles = touchedFiles,
        )
    }
}
