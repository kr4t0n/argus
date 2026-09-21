package app.argus.core.engine

import app.argus.core.metaOf
import app.argus.core.model.ResultKind
import app.argus.core.testChunk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// There is no Swift counterpart for this file; the cases below pin what
// apps/ios/ArgusKit/Sources/ArgusKit/Engine/DedicatedPanels.swift's doc
// comments promise for the to-do half (TodoWindow.tsx parity) and the
// `isDedicatedPanelTool` / `isNestedSubAgentChunk` predicates.

/** DedicatedPanels — port of web TodoWindow + ActivityPill predicates. */
class DedicatedPanelsTest {
    @Test
    fun `extractTodos parses the Claude Code lowercase shape`() {
        val chunks = listOf(
            testChunk(
                id = "t1", seq = 1, kind = ResultKind.TOOL,
                meta = metaOf(
                    """
                    {"tool":"TodoWrite","input":{"todos":[
                      {"content":"Plan","status":"completed"},
                      {"content":"Write tests","status":"in_progress","activeForm":"Writing tests"},
                      {"content":"Ship","status":"pending","activeForm":"Shipping"}
                    ]}}
                    """,
                ),
            ),
        )
        val todos = assertNotNull(DedicatedPanels.extractTodos(chunks))
        assertEquals(
            listOf(
                TodoItem(id = 0, content = "Plan", status = TodoStatus.COMPLETED, activeForm = null),
                TodoItem(id = 1, content = "Write tests", status = TodoStatus.IN_PROGRESS, activeForm = "Writing tests"),
                TodoItem(id = 2, content = "Ship", status = TodoStatus.PENDING, activeForm = "Shipping"),
            ),
            todos,
        )
        // activeForm is preferred ONLY while in progress.
        assertEquals("Plan", todos[0].displayText)
        assertEquals("Writing tests", todos[1].displayText)
        assertEquals("Ship", todos[2].displayText)
    }

    @Test
    fun `extractTodos normalises the cursor TODO_STATUS shape and the updateTodos name`() {
        val chunks = listOf(
            testChunk(
                id = "t1", seq = 1, kind = ResultKind.TOOL,
                meta = metaOf(
                    """
                    {"tool":"updateTodos","input":{"todos":[
                      {"content":"Done","status":"TODO_STATUS_COMPLETED"},
                      {"content":"Doing","status":"TODO_STATUS_IN_PROGRESS"},
                      {"content":"Later","status":"TODO_STATUS_PENDING"},
                      {"content":"Odd","status":"TODO_STATUS_SOMETHING_NEW"}
                    ]}}
                    """,
                ),
            ),
        )
        val todos = assertNotNull(DedicatedPanels.extractTodos(chunks))
        assertEquals(
            listOf(TodoStatus.COMPLETED, TodoStatus.IN_PROGRESS, TodoStatus.PENDING, TodoStatus.PENDING),
            todos.map { it.status },
        )
    }

    @Test
    fun `extractTodos is latest-wins and never merges across calls`() {
        val chunks = listOf(
            testChunk(
                id = "t1", seq = 1, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"TodoWrite","input":{"todos":[{"content":"A","status":"pending"},{"content":"B","status":"pending"}]}}"""),
            ),
            testChunk(id = "d1", seq = 2, kind = ResultKind.DELTA, delta = "working"),
            testChunk(
                id = "t2", seq = 3, kind = ResultKind.TOOL,
                meta = metaOf("""{"tool":"TodoWrite","input":{"todos":[{"content":"A","status":"completed"}]}}"""),
            ),
        )
        val todos = assertNotNull(DedicatedPanels.extractTodos(chunks))
        assertEquals(1, todos.size)
        assertEquals("A", todos[0].content)
        assertEquals(TodoStatus.COMPLETED, todos[0].status)
    }

    @Test
    fun `extractTodos drops malformed rows and blanks empty activeForm`() {
        val chunks = listOf(
            testChunk(
                id = "t1", seq = 1, kind = ResultKind.TOOL,
                meta = metaOf(
                    """
                    {"tool":"todo","input":{"todos":[
                      "not an object",
                      {"status":"pending"},
                      {"content":"","status":"pending"},
                      {"content":"Real","status":"in_progress","activeForm":""}
                    ]}}
                    """,
                ),
            ),
        )
        val todos = assertNotNull(DedicatedPanels.extractTodos(chunks))
        assertEquals(1, todos.size)
        assertEquals(0, todos[0].id)
        assertEquals("Real", todos[0].content)
        assertNull(todos[0].activeForm)
        // With no activeForm, an in-progress row falls back to content.
        assertEquals("Real", todos[0].displayText)
    }

    @Test
    fun `extractTodos returns null when the newest todo chunk is unusable, even if an older one parsed`() {
        val good = testChunk(
            id = "t1", seq = 1, kind = ResultKind.TOOL,
            meta = metaOf("""{"tool":"TodoWrite","input":{"todos":[{"content":"A","status":"pending"}]}}"""),
        )
        // Newest `todos` is not an array → null, no fallback to the older snapshot.
        assertNull(
            DedicatedPanels.extractTodos(
                listOf(
                    good,
                    testChunk(
                        id = "t2", seq = 2, kind = ResultKind.TOOL,
                        meta = metaOf("""{"tool":"TodoWrite","input":{"todos":"nope"}}"""),
                    ),
                ),
            ),
        )
        // Newest array has no parseable rows → null likewise.
        assertNull(
            DedicatedPanels.extractTodos(
                listOf(
                    good,
                    testChunk(
                        id = "t3", seq = 2, kind = ResultKind.TOOL,
                        meta = metaOf("""{"tool":"TodoWrite","input":{"todos":[]}}"""),
                    ),
                ),
            ),
        )
        // No `input` at all on the newest todo chunk → null.
        assertNull(
            DedicatedPanels.extractTodos(
                listOf(
                    good,
                    testChunk(id = "t4", seq = 2, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"TodoWrite"}""")),
                ),
            ),
        )
    }

    @Test
    fun `extractTodos ignores non-todo tools and non-tool chunks`() {
        // A todo-named chunk of the wrong kind is not a source (codex
        // sessions, or a turn that never planned via todos → null).
        assertNull(
            DedicatedPanels.extractTodos(
                listOf(
                    testChunk(
                        id = "p1", seq = 1, kind = ResultKind.PROGRESS,
                        meta = metaOf("""{"tool":"TodoWrite","input":{"todos":[{"content":"A","status":"pending"}]}}"""),
                    ),
                    testChunk(
                        id = "t1", seq = 2, kind = ResultKind.TOOL,
                        meta = metaOf("""{"tool":"Read","input":{"file_path":"/w/a.ts"}}"""),
                    ),
                ),
            ),
        )
        assertNull(DedicatedPanels.extractTodos(emptyList()))
    }

    @Test
    fun `normaliseTodoStatus accepts both shapes case-insensitively and defaults to pending`() {
        assertEquals(TodoStatus.PENDING, DedicatedPanels.normaliseTodoStatus(null))
        assertEquals(TodoStatus.PENDING, DedicatedPanels.normaliseTodoStatus(""))
        assertEquals(TodoStatus.PENDING, DedicatedPanels.normaliseTodoStatus("pending"))
        assertEquals(TodoStatus.PENDING, DedicatedPanels.normaliseTodoStatus("garbage"))
        assertEquals(TodoStatus.COMPLETED, DedicatedPanels.normaliseTodoStatus("completed"))
        assertEquals(TodoStatus.COMPLETED, DedicatedPanels.normaliseTodoStatus("Completed"))
        assertEquals(TodoStatus.COMPLETED, DedicatedPanels.normaliseTodoStatus("TODO_STATUS_COMPLETED"))
        assertEquals(TodoStatus.IN_PROGRESS, DedicatedPanels.normaliseTodoStatus("in_progress"))
        assertEquals(TodoStatus.IN_PROGRESS, DedicatedPanels.normaliseTodoStatus("TODO_STATUS_IN_PROGRESS"))
    }

    @Test
    fun `isDedicatedPanelTool matches panel tools case-insensitively, on tool chunks only`() {
        val panelTools = listOf(
            "Agent", "TodoWrite", "todo", "task", "updateTodos",
            "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
        )
        for (tool in panelTools) {
            val chunk = testChunk(id = "t-$tool", seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"$tool"}"""))
            assertTrue(DedicatedPanels.isDedicatedPanelTool(chunk), "expected $tool to be a dedicated-panel tool")
        }
        // Ordinary tools stay in the timeline.
        assertFalse(
            DedicatedPanels.isDedicatedPanelTool(
                testChunk(id = "r", seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"Read"}""")),
            ),
        )
        // Only tool chunks qualify, regardless of the name.
        assertFalse(
            DedicatedPanels.isDedicatedPanelTool(
                testChunk(id = "p", seq = 1, kind = ResultKind.PROGRESS, meta = metaOf("""{"tool":"TodoWrite"}""")),
            ),
        )
        // No meta / no tool name.
        assertFalse(DedicatedPanels.isDedicatedPanelTool(testChunk(id = "n", seq = 1, kind = ResultKind.TOOL)))
        assertFalse(
            DedicatedPanels.isDedicatedPanelTool(
                testChunk(id = "e", seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"input":{}}""")),
            ),
        )
    }

    @Test
    fun `toolName lowercases and defaults to empty`() {
        assertEquals(
            "todowrite",
            DedicatedPanels.toolName(testChunk(seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"TodoWrite"}"""))),
        )
        assertEquals("", DedicatedPanels.toolName(testChunk(seq = 1, kind = ResultKind.TOOL)))
        assertEquals(
            "",
            DedicatedPanels.toolName(testChunk(seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":7}"""))),
        )
    }

    @Test
    fun `isNested is true only for a non-empty parentToolUseId`() {
        assertTrue(
            DedicatedPanels.isNested(
                testChunk(seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"Read","parentToolUseId":"toolu_1"}""")),
            ),
        )
        assertFalse(
            DedicatedPanels.isNested(
                testChunk(seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"Read","parentToolUseId":""}""")),
            ),
        )
        assertFalse(DedicatedPanels.isNested(testChunk(seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"Read"}"""))))
        assertFalse(DedicatedPanels.isNested(testChunk(seq = 1, kind = ResultKind.DELTA, delta = "x")))
    }

    @Test
    fun `firstLine trims and takes the first line`() {
        assertEquals("Edited a.swift", DedicatedPanels.firstLine("  Edited a.swift\nsecond line\n"))
        assertEquals("single", DedicatedPanels.firstLine("single"))
        assertNull(DedicatedPanels.firstLine("   \n  "))
        assertNull(DedicatedPanels.firstLine(""))
        assertNull(DedicatedPanels.firstLine(null))
    }

    // The sub-agent cases below mirror the two SubAgent tests in
    // apps/ios/ArgusKit/Tests/ArgusKitTests/TranscriptEngineTests.swift,
    // exercised at the DedicatedPanels level (no TranscriptState needed).

    @Test
    fun `extractSubAgents groups nested tools, text runs and thinking under the agent`() {
        val chunks = listOf(
            testChunk(
                id = "a1", seq = 1, kind = ResultKind.TOOL, content = "Agent",
                meta = metaOf(
                    """{"tool":"Agent","id":"agent-1","input":{"subagent_type":"explorer","description":"scan repo","prompt":"find bugs"}}""",
                ),
            ),
            // Nested tool inside the sub-agent.
            testChunk(
                id = "n1", seq = 2, kind = ResultKind.TOOL, content = "Read x",
                meta = metaOf("""{"tool":"Read","id":"nested-1","parentToolUseId":"agent-1","input":{"file_path":"x.swift"}}"""),
            ),
            testChunk(
                id = "nr1", seq = 3, kind = ResultKind.STDOUT, content = "file body",
                meta = metaOf("""{"toolResultFor":"nested-1","parentToolUseId":"agent-1"}"""),
            ),
            // The sub-agent's streamed response prose: two adjacent nested
            // deltas coalesce into ONE thought item scoped to the card.
            testChunk(id = "nd1", seq = 4, kind = ResultKind.DELTA, delta = "Found the bug ", meta = metaOf("""{"parentToolUseId":"agent-1"}""")),
            testChunk(id = "nd2", seq = 5, kind = ResultKind.DELTA, delta = "in x.swift.", meta = metaOf("""{"parentToolUseId":"agent-1"}""")),
            // Nested thinking is scoped to the card too.
            testChunk(
                id = "nt1", seq = 6, kind = ResultKind.PROGRESS, content = "nested reasoning",
                meta = metaOf("""{"contentType":"thinking","parentToolUseId":"agent-1"}"""),
            ),
            // The Agent tool's own result.
            testChunk(id = "ar1", seq = 7, kind = ResultKind.STDOUT, content = "found 2 bugs", meta = metaOf("""{"toolResultFor":"agent-1"}""")),
            testChunk(id = "f1", seq = 8, kind = ResultKind.FINAL, isFinal = true),
        )
        val calls = DedicatedPanels.extractSubAgents(chunks)
        assertEquals(1, calls.size)
        val sub = calls[0]
        assertEquals("agent-1", sub.id)
        assertEquals("explorer", sub.subagentType)
        assertEquals("scan repo", sub.description)
        assertEquals("find bugs", sub.prompt)
        assertEquals("found 2 bugs", sub.result)
        assertFalse(sub.isError)
        // Chronological: the tool call, then the coalesced text run, then
        // the thinking block.
        assertEquals(3, sub.nested.size)
        assertEquals(TimelineItem.Kind.Tool, sub.nested[0].kind)
        assertEquals("Read", sub.nested[0].toolName)
        assertEquals("file body", sub.nested[0].resultText)
        assertEquals("x.swift", sub.nested[0].filePath)
        assertEquals(TimelineItem.Kind.Thought, sub.nested[1].kind)
        assertEquals("nd1:subtext", sub.nested[1].id)
        assertEquals("Found the bug in x.swift.", sub.nested[1].text)
        assertEquals(TimelineItem.Kind.Thinking(redacted = false), sub.nested[2].kind)
        assertEquals("nt1:subthink", sub.nested[2].id)
        assertEquals("nested reasoning", sub.nested[2].text)
    }

    @Test
    fun `extractSubAgents background run uses the notification, never the launch boilerplate`() {
        val agentChunk = testChunk(
            id = "a1", seq = 1, kind = ResultKind.TOOL, content = "Agent",
            meta = metaOf("""{"tool":"Agent","id":"agent-1","input":{"subagent_type":"explorer","prompt":"count files","run_in_background":true}}"""),
        )
        val boilerplate = testChunk(
            id = "r1", seq = 2, kind = ResultKind.STDOUT,
            content = "Async agent launched successfully. agentId: abc123 …",
            meta = metaOf("""{"toolResultFor":"agent-1"}"""),
        )

        // Launched, no notification yet (or an old row where the sidecar
        // dropped it): the boilerplate must NOT surface as the result.
        val live = assertNotNull(DedicatedPanels.extractSubAgents(listOf(agentChunk, boilerplate)).firstOrNull())
        assertNull(live.result)
        assertFalse(live.isError)

        // Notification landed: its summary is the card's result, and the
        // sub-agent's streamed report stays in the card as a thought.
        val done = DedicatedPanels.extractSubAgents(
            listOf(
                agentChunk, boilerplate,
                testChunk(id = "d0", seq = 3, kind = ResultKind.DELTA, delta = "It is running now."),
                testChunk(
                    id = "ns1", seq = 4, kind = ResultKind.STDOUT, content = "nested tool result",
                    meta = metaOf("""{"toolResultFor":"nested-1","parentToolUseId":"agent-1"}"""),
                ),
                testChunk(id = "nd1", seq = 5, kind = ResultKind.DELTA, delta = "SUBAGENT REPORT", meta = metaOf("""{"parentToolUseId":"agent-1"}""")),
                testChunk(
                    id = "n1", seq = 6, kind = ResultKind.PROGRESS, content = "Found 10 files.",
                    meta = metaOf("""{"contentType":"task_notification","tool_use_id":"agent-1","status":"completed"}"""),
                ),
                testChunk(id = "d1", seq = 7, kind = ResultKind.DELTA, delta = "The real answer."),
                testChunk(id = "f1", seq = 8, kind = ResultKind.FINAL, isFinal = true),
            ),
        )
        val sub = assertNotNull(done.firstOrNull())
        assertEquals("Found 10 files.", sub.result)
        assertFalse(sub.isError)
        assertTrue(sub.nested.any { it.kind == TimelineItem.Kind.Thought && it.text == "SUBAGENT REPORT" })
        // Top-level text never lands in the card.
        assertFalse(sub.nested.any { it.text.contains("It is running now.") || it.text.contains("The real answer.") })
    }

    @Test
    fun `extractSubAgents flags errors from stderr results and non-completed notifications`() {
        val syncAgent = testChunk(
            id = "a1", seq = 1, kind = ResultKind.TOOL, content = "Agent",
            meta = metaOf("""{"tool":"Agent","id":"agent-1","input":{"subagentType":"worker"}}"""),
        )
        val failed = DedicatedPanels.extractSubAgents(
            listOf(
                syncAgent,
                testChunk(id = "e1", seq = 2, kind = ResultKind.STDERR, content = " boom ", meta = metaOf("""{"toolResultFor":"agent-1"}""")),
            ),
        )
        assertEquals(1, failed.size)
        // The camelCase subagentType alias is honoured; the result is trimmed.
        assertEquals("worker", failed[0].subagentType)
        assertEquals("boom", failed[0].result)
        assertTrue(failed[0].isError)

        // A notification with any status other than "completed" is an error,
        // and it wins over the paired stdout result.
        val notified = DedicatedPanels.extractSubAgents(
            listOf(
                syncAgent,
                testChunk(id = "r1", seq = 2, kind = ResultKind.STDOUT, content = "partial", meta = metaOf("""{"toolResultFor":"agent-1"}""")),
                testChunk(
                    id = "n1", seq = 3, kind = ResultKind.PROGRESS, content = "Timed out.",
                    meta = metaOf("""{"contentType":"task_notification","tool_use_id":"agent-1","status":"failed"}"""),
                ),
            ),
        )
        assertEquals("Timed out.", notified[0].result)
        assertTrue(notified[0].isError)

        // No `id` on the Agent tool chunk falls back to the chunk id.
        val anonymous = DedicatedPanels.extractSubAgents(
            listOf(testChunk(id = "chunk-9", seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"agent"}"""))),
        )
        assertEquals("chunk-9", anonymous[0].id)
        assertEquals("", anonymous[0].subagentType)
        assertNull(anonymous[0].result)
        assertTrue(anonymous[0].nested.isEmpty())
    }

    @Test
    fun `extractSubAgents closes a text run when a sibling or top-level chunk interrupts`() {
        val chunks = listOf(
            testChunk(id = "a1", seq = 1, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"Agent","id":"agent-1","input":{}}""")),
            testChunk(id = "a2", seq = 2, kind = ResultKind.TOOL, meta = metaOf("""{"tool":"Agent","id":"agent-2","input":{}}""")),
            testChunk(id = "d1", seq = 3, kind = ResultKind.DELTA, delta = "one ", meta = metaOf("""{"parentToolUseId":"agent-1"}""")),
            // A parallel sibling's delta closes agent-1's run.
            testChunk(id = "d2", seq = 4, kind = ResultKind.DELTA, delta = "two", meta = metaOf("""{"parentToolUseId":"agent-2"}""")),
            testChunk(id = "d3", seq = 5, kind = ResultKind.DELTA, delta = "three", meta = metaOf("""{"parentToolUseId":"agent-1"}""")),
            // A top-level chunk closes agent-1's second run.
            testChunk(id = "t1", seq = 6, kind = ResultKind.DELTA, delta = "top-level"),
            testChunk(id = "d4", seq = 7, kind = ResultKind.DELTA, delta = "four", meta = metaOf("""{"parentToolUseId":"agent-1"}""")),
            // Whitespace-only runs are dropped.
            testChunk(id = "d5", seq = 8, kind = ResultKind.DELTA, delta = "  \n", meta = metaOf("""{"parentToolUseId":"agent-2"}""")),
        )
        val calls = DedicatedPanels.extractSubAgents(chunks)
        assertEquals(listOf("agent-1", "agent-2"), calls.map { it.id })
        assertEquals(listOf("one ", "three", "four"), calls[0].nested.map { it.text })
        assertEquals(listOf("d1:subtext", "d3:subtext", "d4:subtext"), calls[0].nested.map { it.id })
        assertEquals(listOf("two"), calls[1].nested.map { it.text })
    }

    @Test
    fun `toolItem folds the paired result into the tool row`() {
        val edit = testChunk(
            id = "t1", seq = 1, kind = ResultKind.TOOL, content = "Edited a.ts",
            meta = metaOf("""{"tool":"Edit","id":"tool-1","input":{"file_path":"/w/a.ts","old":"x"}}"""),
        )
        val diff = testChunk(
            id = "r1", seq = 2, kind = ResultKind.STDOUT, content = "--- a\n+++ b",
            meta = metaOf("""{"toolResultFor":"tool-1","isDiff":true,"filePath":"/w/a.ts","exitCode":0}"""),
        )
        val item = DedicatedPanels.toolItem(edit, mapOf("tool-1" to diff))
        assertEquals("t1", item.id)
        assertEquals(TimelineItem.Kind.Tool, item.kind)
        assertEquals(1, item.seq)
        assertEquals("Edited a.ts", item.text)
        assertEquals("Edit", item.toolName)
        assertEquals(metaOf("""{"file_path":"/w/a.ts","old":"x"}"""), item.toolInput)
        assertEquals("--- a\n+++ b", item.resultText)
        assertFalse(item.isError)
        assertTrue(item.isDiff)
        assertEquals("/w/a.ts", item.filePath)
        assertEquals(0, item.exitCode)

        // stderr result → error row; filePath falls back to the input.
        val failing = testChunk(
            id = "t2", seq = 3, kind = ResultKind.TOOL,
            meta = metaOf("""{"tool":"Bash","id":"tool-2","input":{"command":"make","file_path":"Makefile"}}"""),
        )
        val stderr = testChunk(id = "r2", seq = 4, kind = ResultKind.STDERR, content = "error", meta = metaOf("""{"toolResultFor":"tool-2","exitCode":2}"""))
        val errorItem = DedicatedPanels.toolItem(failing, mapOf("tool-2" to stderr))
        assertTrue(errorItem.isError)
        assertFalse(errorItem.isDiff)
        assertEquals("Makefile", errorItem.filePath)
        assertEquals(2, errorItem.exitCode)
        assertEquals("", errorItem.text)

        // No `meta.tool` → the content's first line names the tool; no
        // pairing → no result fields.
        val bare = DedicatedPanels.toolItem(
            testChunk(id = "t3", seq = 5, kind = ResultKind.TOOL, content = "  Grep pattern\nmore"),
            emptyMap(),
        )
        assertEquals("Grep pattern", bare.toolName)
        assertNull(bare.resultText)
        assertNull(bare.toolInput)
        assertNull(bare.exitCode)
        assertEquals("tool", DedicatedPanels.toolItem(testChunk(id = "t4", seq = 6, kind = ResultKind.TOOL), emptyMap()).toolName)
    }
}
