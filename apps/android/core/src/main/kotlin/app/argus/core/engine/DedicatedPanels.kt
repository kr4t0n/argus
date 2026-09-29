package app.argus.core.engine

import app.argus.core.model.ResultChunk
import app.argus.core.model.ResultKind
import app.argus.core.model.asArray
import app.argus.core.model.asBool
import app.argus.core.model.asInt
import app.argus.core.model.asObject
import app.argus.core.model.asString
import app.argus.core.model.get

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/DedicatedPanels.swift.
//
// Sub-agent + to-do "dedicated panels" — ports of the web's TodoWindow /
// SubAgentWindow (`apps/web/src/components/{TodoWindow,SubAgentWindow}.tsx`)
// plus the `isNestedSubAgentChunk` / `isDedicatedPanelTool` predicates in
// ActivityPill.tsx that keep these chunks OUT of the main tool timeline.
// `TimelineItem` (the nested rows) is declared in TranscriptEngine.kt, the
// same split as ArgusKit.

/** Canonical to-do state — the three values TodoWindow renders. */
enum class TodoStatus {
    PENDING,
    IN_PROGRESS,
    COMPLETED,
}

data class TodoItem(
    /** Row index within its snapshot (the list is replaced wholesale per call). */
    val id: Int,
    val content: String,
    val status: TodoStatus,
    /**
     * Present-continuous form ("Writing tests") — shown only while the
     * row is in progress.
     */
    val activeForm: String?,
) {
    /**
     * Prefer [activeForm] for an in-progress row so it reads as "doing X"
     * instead of the imperative form; [content] for pending/completed.
     */
    val displayText: String
        get() = if (status == TodoStatus.IN_PROGRESS) activeForm ?: content else content
}

/**
 * One `Agent`/Task sub-agent invocation with its nested tool calls and
 * result folded in.
 */
data class SubAgentCall(
    val id: String,
    val subagentType: String,
    val description: String,
    val prompt: String,
    /** Trimmed result body, null when empty. */
    val result: String?,
    val isError: Boolean,
    /**
     * The sub-agent's chronological activity: [TimelineItem.Kind.Tool]
     * items (so the UI reuses the tool card), [TimelineItem.Kind.Thought]
     * items (coalesced runs of the sub-agent's streamed text — its
     * preamble narration and response prose), and
     * [TimelineItem.Kind.Thinking] items.
     */
    val nested: List<TimelineItem>,
)

object DedicatedPanels {
    /** Tools that render in a dedicated panel, never the main timeline. */
    val dedicatedToolNames: Set<String> = setOf(
        "agent", "todowrite", "todo", "task", "updatetodos",
        // Claude Code ≥ 2.1.x incremental task tools. The sidecar follows
        // each result with a synthesized TodoWrite snapshot that drives the
        // to-do panel, so the raw calls would only duplicate it in the
        // timeline.
        "taskcreate", "taskupdate", "tasklist", "taskget",
    )

    /**
     * Tool names TodoWindow sources its list from. `updatetodos` is
     * cursor-agent's tool name when the sidecar mapper hasn't normalised
     * it (older builds, or future cursor variants); tolerated so the
     * panel still renders if the adapter falls behind.
     */
    val todoToolNames: Set<String> = setOf("todowrite", "todo", "task", "updatetodos")

    /** Lowercased `meta.tool`, or "" when absent. */
    fun toolName(chunk: ResultChunk): String =
        (chunk.meta?.get("tool")?.asString ?: "").lowercase()

    /** A chunk that happened INSIDE a sub-agent (non-empty parentToolUseId). */
    fun isNested(chunk: ResultChunk): Boolean =
        !chunk.meta?.get("parentToolUseId")?.asString.isNullOrEmpty()

    /**
     * True when a tool chunk is one rendered in a dedicated turn-level
     * panel above the activity timeline — keep in sync with
     * [todoToolNames] / [extractTodos]. The timeline hides these so the
     * same call isn't rendered twice (once in the panel, once as a row).
     */
    fun isDedicatedPanelTool(chunk: ResultChunk): Boolean =
        chunk.kind == ResultKind.TOOL && toolName(chunk) in dedicatedToolNames

    /**
     * Coerce a raw status into one of the three canonical values.
     * Accepts Claude Code lowercase and cursor-agent `TODO_STATUS_*`, so
     * the panel renders correctly even if upstream stream-json drifts
     * before the sidecar mapper catches up. Anything else is pending.
     */
    fun normaliseTodoStatus(raw: String?): TodoStatus =
        when ((raw ?: "").uppercase()) {
            "COMPLETED", "TODO_STATUS_COMPLETED" -> TodoStatus.COMPLETED
            "IN_PROGRESS", "TODO_STATUS_IN_PROGRESS" -> TodoStatus.IN_PROGRESS
            else -> TodoStatus.PENDING
        }

    /**
     * Latest-wins: the most recent todo tool chunk carries the full list
     * (each call replaces it; nothing is merged across calls). null when
     * there's none, or the newest one's `todos` isn't an array, or none
     * of its rows parse.
     *
     * Defensive on shape: TodoWrite input has been observed as
     * `{ todos: [{ content, status, activeForm? }] }` across both Claude
     * Code and Cursor CLI, but adapter-level stream-json drift is a known
     * gotcha (see AGENTS.md). Fields are coerced individually, malformed
     * rows dropped, and `status` clamped to the three known values.
     */
    fun extractTodos(chunks: List<ResultChunk>): List<TodoItem>? {
        for (chunk in chunks.asReversed()) {
            if (chunk.kind != ResultKind.TOOL || toolName(chunk) !in todoToolNames) continue
            val raw = chunk.meta?.get("input")?.get("todos")?.asArray ?: return null
            val parsed = ArrayList<TodoItem>()
            for (row in raw) {
                val obj = row.asObject ?: continue
                val content = obj["content"]?.asString ?: ""
                if (content.isEmpty()) continue
                val activeForm = obj["activeForm"]?.asString
                parsed.add(
                    TodoItem(
                        id = parsed.size,
                        content = content,
                        status = normaliseTodoStatus(obj["status"]?.asString),
                        activeForm = activeForm?.takeIf { it.isNotEmpty() },
                    ),
                )
            }
            return if (parsed.isEmpty()) null else parsed
        }
        return null
    }

    /**
     * Group each top-level `agent` tool's nested activity under it, in
     * stream order: tool calls, thinking blocks, and the sub-agent's
     * own streamed text (adjacent nested deltas coalesce into one
     * thought item, mirroring the parent timeline; any chunk from
     * anything else — top-level or a parallel sibling — closes the run).
     */
    fun extractSubAgents(chunks: List<ResultChunk>): List<SubAgentCall> {
        val resultByToolId = HashMap<String, ResultChunk>()
        for (chunk in chunks) {
            if (chunk.kind != ResultKind.STDOUT && chunk.kind != ResultKind.STDERR) continue
            val rid = chunk.meta?.get("toolResultFor")?.asString ?: continue
            resultByToolId[rid] = chunk
        }

        val nestedByParent = HashMap<String, ArrayList<TimelineItem>>()
        var textParent = ""
        val textBuffer = StringBuilder()
        var textStartId: String? = null
        var textStartSeq = 0
        fun flushText() {
            val startId = textStartId
            if (startId != null && textBuffer.isNotBlank()) {
                nestedByParent.getOrPut(textParent) { ArrayList() }.add(
                    TimelineItem(
                        id = "$startId:subtext",
                        kind = TimelineItem.Kind.Thought,
                        seq = textStartSeq,
                        text = textBuffer.toString(),
                    ),
                )
            }
            textBuffer.setLength(0)
            textStartId = null
            textParent = ""
        }
        for (chunk in chunks) {
            val pid = chunk.meta?.get("parentToolUseId")?.asString ?: ""
            if (pid.isEmpty() || (textStartId != null && textParent != pid)) flushText()
            if (pid.isEmpty()) continue
            when (chunk.kind) {
                ResultKind.DELTA -> {
                    if (textStartId == null) {
                        textStartId = chunk.id
                        textStartSeq = chunk.seq
                        textParent = pid
                    }
                    textBuffer.append(chunk.delta ?: "")
                }
                ResultKind.TOOL -> {
                    flushText()
                    nestedByParent.getOrPut(pid) { ArrayList() }.add(toolItem(chunk, resultByToolId))
                }
                ResultKind.PROGRESS -> {
                    // Only thinking blocks join the card; other nested
                    // progress (thinking_tokens, …) neither renders nor
                    // interrupts an open text run.
                    if (chunk.meta?.get("contentType")?.asString != "thinking") continue
                    val text = (chunk.content ?: "").trim()
                    if (text.isEmpty()) continue
                    flushText()
                    nestedByParent.getOrPut(pid) { ArrayList() }.add(
                        TimelineItem(
                            id = "${chunk.id}:subthink",
                            kind = TimelineItem.Kind.Thinking(
                                redacted = chunk.meta?.get("redacted")?.asBool == true,
                            ),
                            seq = chunk.seq,
                            text = chunk.content ?: "",
                        ),
                    )
                }
                else -> flushText()
            }
        }
        flushText()

        // Background completion reports: `task_notification` progress
        // chunks carry the sub-agent's full final report in `content`,
        // attributed via meta.tool_use_id. Later wins.
        val notificationByToolId = HashMap<String, ResultChunk>()
        for (chunk in chunks) {
            if (chunk.kind != ResultKind.PROGRESS) continue
            if (chunk.meta?.get("contentType")?.asString != "task_notification") continue
            val tid = chunk.meta?.get("tool_use_id")?.asString
            if (tid.isNullOrEmpty()) continue
            if (chunk.content.isNullOrEmpty()) continue
            notificationByToolId[tid] = chunk
        }

        val calls = ArrayList<SubAgentCall>()
        for (chunk in chunks) {
            if (chunk.kind != ResultKind.TOOL || toolName(chunk) != "agent") continue
            val toolId = chunk.meta?.get("id")?.asString
            val id = if (!toolId.isNullOrEmpty()) toolId else chunk.id
            val input = chunk.meta?.get("input")?.asObject
            val subType = input?.get("subagent_type")?.asString
                ?: input?.get("subagentType")?.asString
                ?: ""
            val paired = resultByToolId[id]
            val notification = notificationByToolId[id]
            // Background runs (run_in_background: true): the Task
            // tool_result is only launch boilerplate — the real report
            // arrives via task_notification. Until it lands (or for old
            // rows where the sidecar dropped it), show no result rather
            // than the boilerplate blob. Sync runs keep the tool_result.
            val isBackground = input?.get("run_in_background")?.asBool == true
            val notifText = notification?.content?.trim()
            val pairedText = paired?.content?.trim()
            val resultText = when {
                !notifText.isNullOrEmpty() -> notifText
                isBackground -> null
                else -> pairedText
            }
            val isError = if (notification != null) {
                val status = notification.meta?.get("status")?.asString
                status != null && status != "completed"
            } else {
                paired?.kind == ResultKind.STDERR
            }
            val nested: List<TimelineItem> = nestedByParent[id] ?: emptyList()
            calls.add(
                SubAgentCall(
                    id = id,
                    subagentType = subType,
                    description = input?.get("description")?.asString ?: "",
                    prompt = input?.get("prompt")?.asString ?: "",
                    result = resultText?.takeIf { it.isNotEmpty() },
                    isError = isError,
                    nested = nested,
                ),
            )
        }
        return calls
    }

    /**
     * Build a [TimelineItem.Kind.Tool] row with its paired result folded
     * in — shared by the main timeline and the sub-agent nested lists.
     */
    fun toolItem(chunk: ResultChunk, resultByToolId: Map<String, ResultChunk>): TimelineItem {
        val name = chunk.meta?.get("tool")?.asString ?: firstLine(chunk.content) ?: "tool"
        val toolId = chunk.meta?.get("id")?.asString
        val result = toolId?.let { resultByToolId[it] }
        return TimelineItem(
            id = chunk.id,
            kind = TimelineItem.Kind.Tool,
            seq = chunk.seq,
            text = chunk.content ?: "",
            toolName = name,
            toolInput = chunk.meta?.get("input")?.asObject,
            resultText = result?.content,
            isError = result?.kind == ResultKind.STDERR,
            isDiff = result?.meta?.get("isDiff")?.asBool ?: false,
            filePath = result?.meta?.get("filePath")?.asString
                ?: chunk.meta?.get("input")?.get("file_path")?.asString,
            exitCode = result?.meta?.get("exitCode")?.asInt,
        )
    }

    /** First line of the trimmed text, or null when there is none. */
    fun firstLine(text: String?): String? {
        val trimmed = text?.trim() ?: return null
        if (trimmed.isEmpty()) return null
        return trimmed.substringBefore('\n')
    }
}
