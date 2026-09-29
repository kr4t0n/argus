package app.argus.core.engine

import app.argus.core.metaOf
import app.argus.core.model.CommandStatus
import app.argus.core.model.KnownAgentType
import app.argus.core.model.ResultKind
import app.argus.core.testChunk
import app.argus.core.testCommand
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/TranscriptEngineTests.swift.

/** TranscriptState — ingest invariants + turn building. */
class TranscriptEngineTest {
    @Test
    fun `chunks dedup by id and order by seq`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.RUNNING))

        val first = testChunk(id = "c1", seq = 2, kind = ResultKind.DELTA, delta = "b")
        val insertedFirst = state.append(first)
        val insertedDuplicate = state.append(first)
        val insertedSecond = state.append(testChunk(id = "c2", seq = 1, kind = ResultKind.DELTA, delta = "a"))
        assertTrue(insertedFirst)
        assertFalse(insertedDuplicate)
        assertTrue(insertedSecond)

        val ordered = state.chunksByCommand["cmd-1"]?.map { it.seq }
        assertEquals(listOf(1, 2), ordered)
        assertEquals(2, state.maxSeq)
    }

    @Test
    fun `foreign-session chunks are rejected`() {
        val state = TranscriptState("sess-1")
        val foreign = testChunk(sessionId = "sess-OTHER", seq = 1, kind = ResultKind.DELTA, delta = "x")
        val inserted = state.append(foreign)
        assertFalse(inserted)
    }

    @Test
    fun `command upsert replaces in place and keeps createdAt order`() {
        val state = TranscriptState("sess-1")
        state.upsert(
            testCommand(id = "cmd-2", status = CommandStatus.RUNNING, createdAt = "2026-07-05T11:00:00.000Z"),
        )
        state.upsert(
            testCommand(id = "cmd-1", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T10:00:00.000Z"),
        )
        assertEquals(listOf("cmd-1", "cmd-2"), state.commands.map { it.id })
        assertTrue(state.isRunning)

        state.upsert(
            testCommand(id = "cmd-2", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T11:00:00.000Z"),
        )
        assertFalse(state.isRunning)
        assertEquals(2, state.commands.size)
    }

    @Test
    fun `status flips never wipe a turns attachments`() {
        val state = TranscriptState("sess-1")
        // Creation carries the attachments…
        state.upsert(testCommand(status = CommandStatus.RUNNING, attachmentIds = listOf("att-1")))
        // …but the finalize command:updated event does NOT (bare
        // CommandService.toDto server-side) — it must not wipe them.
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        val turn = assertNotNull(state.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        assertEquals(CommandStatus.COMPLETED, turn.status)
        assertEquals(listOf("att-1"), turn.attachments.map { it.id })

        // A later load that DOES carry attachments stays authoritative.
        state.upsert(testCommand(status = CommandStatus.COMPLETED, attachmentIds = listOf("att-1", "att-2")))
        val reloaded = assertNotNull(state.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        assertEquals(2, reloaded.attachments.size)
    }

    @Test
    fun `turn building narration vs answer tool timeline usage`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))

        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(id = "d1", seq = 1, kind = ResultKind.DELTA, delta = "let me look"),
                testChunk(
                    id = "t1", seq = 2, kind = ResultKind.TOOL, content = "Read main.swift",
                    meta = metaOf("""{"tool": "Read", "id": "toolu_1"}"""),
                ),
                testChunk(
                    id = "o1", seq = 3, kind = ResultKind.STDOUT, content = "file contents",
                    meta = metaOf("""{"toolResultFor": "toolu_1"}"""),
                ),
                testChunk(id = "d2", seq = 4, kind = ResultKind.DELTA, delta = "The answer is 42."),
                testChunk(
                    id = "f1", seq = 5, kind = ResultKind.FINAL, content = "The answer is 42.",
                    meta = metaOf("""{"usage": {"input_tokens": 100, "output_tokens": 20}}"""),
                    isFinal = true,
                ),
            ),
        )

        val turn = assertNotNull(state.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        assertEquals("The answer is 42.", turn.answer)
        assertEquals("let me look", turn.narration)
        assertFalse(turn.isRunning)
        // The pre-tool delta interleaves as a thought row; the stdout is
        // PAIRED into the tool row (web parity), not a standalone item.
        assertEquals(2, turn.timeline.size)
        assertEquals(TimelineItem.Kind.Thought, turn.timeline[0].kind)
        assertEquals("let me look", turn.timeline[0].text)
        assertEquals(TimelineItem.Kind.Tool, turn.timeline[1].kind)
        assertEquals("Read", turn.timeline[1].toolName)
        assertEquals("file contents", turn.timeline[1].resultText)
        assertEquals(100.0, turn.usage?.inputTokens)
    }

    @Test
    fun `edit tool folds its diff result into the row`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "t1", seq = 1, kind = ResultKind.TOOL, content = "Edit app.swift",
                    meta = metaOf("""{"tool": "Edit", "id": "toolu_9", "input": {"file_path": "app.swift"}}"""),
                ),
                testChunk(
                    id = "o1", seq = 2, kind = ResultKind.STDOUT, content = "@@ -1 +1 @@\n-old\n+new",
                    meta = metaOf("""{"toolResultFor": "toolu_9", "isDiff": true, "filePath": "app.swift"}"""),
                ),
            ),
        )
        val turn = assertNotNull(state.turns("custom").firstOrNull())
        assertEquals(1, turn.timeline.size)
        val tool = turn.timeline[0]
        assertEquals("Edit", tool.toolName)
        assertTrue(tool.isDiff)
        assertEquals("app.swift", tool.filePath)
        assertTrue(tool.diffBody.contains("+new"))
    }

    @Test
    fun `intermediate deltas interleave as thought rows between tools`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(id = "d1", seq = 1, kind = ResultKind.DELTA, delta = "let me look"),
                testChunk(
                    id = "t1", seq = 2, kind = ResultKind.TOOL, content = "Read a",
                    meta = metaOf("""{"tool": "Read", "id": "x1"}"""),
                ),
                testChunk(id = "d2", seq = 3, kind = ResultKind.DELTA, delta = "now edit"),
                testChunk(
                    id = "t2", seq = 4, kind = ResultKind.TOOL, content = "Edit b",
                    meta = metaOf("""{"tool": "Edit", "id": "x2"}"""),
                ),
                testChunk(id = "d3", seq = 5, kind = ResultKind.DELTA, delta = "All done."),
                testChunk(id = "f1", seq = 6, kind = ResultKind.FINAL, isFinal = true),
            ),
        )
        val turn = assertNotNull(state.turns("custom").firstOrNull())
        // thought, tool, thought, tool — interleaved by seq. The trailing
        // delta (seq 5 > boundary 4) is the answer, not a thought.
        assertEquals(
            listOf<TimelineItem.Kind>(
                TimelineItem.Kind.Thought,
                TimelineItem.Kind.Tool,
                TimelineItem.Kind.Thought,
                TimelineItem.Kind.Tool,
            ),
            turn.timeline.map { it.kind },
        )
        assertEquals("let me look", turn.timeline[0].text)
        assertEquals("now edit", turn.timeline[2].text)
        assertEquals("All done.", turn.answer)
    }

    @Test
    fun `tool-narration progress with tool_use_id is dropped not a system row`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "t1", seq = 1, kind = ResultKind.TOOL, content = "Bash",
                    meta = metaOf("""{"tool": "Bash", "id": "x1", "input": {"command": "git add ."}}"""),
                ),
                // Claude's task_started description, tagged with tool_use_id —
                // duplicates the tool row, so it must not render.
                testChunk(
                    id = "p1", seq = 2, kind = ResultKind.PROGRESS, content = "Commit changes",
                    meta = metaOf("""{"tool_use_id": "x1"}"""),
                ),
            ),
        )
        val turn = assertNotNull(state.turns("custom").firstOrNull())
        assertEquals(listOf<TimelineItem.Kind>(TimelineItem.Kind.Tool), turn.timeline.map { it.kind })
        assertFalse(turn.timeline.any { it.kind == TimelineItem.Kind.System })
    }

    @Test
    fun `live turn trailing text folds into the pill not the answer body`() {
        val state = TranscriptState("sess-1")
        // Running turn: a thought, a tool, then trailing text still streaming.
        state.upsert(testCommand(status = CommandStatus.RUNNING))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(id = "d1", seq = 1, kind = ResultKind.DELTA, delta = "let me check"),
                testChunk(
                    id = "t1", seq = 2, kind = ResultKind.TOOL, content = "Read a",
                    meta = metaOf("""{"tool": "Read", "id": "x1"}"""),
                ),
                testChunk(id = "d2", seq = 3, kind = ResultKind.DELTA, delta = "here is the answer"),
            ),
        )
        var turn = assertNotNull(state.turns("custom").firstOrNull())
        // While live, the trailing delta is a thought (in the pill) and the
        // answer body stays empty — no flash.
        assertTrue(turn.answer.isEmpty())
        assertEquals(
            listOf<TimelineItem.Kind>(
                TimelineItem.Kind.Thought,
                TimelineItem.Kind.Tool,
                TimelineItem.Kind.Thought,
            ),
            turn.timeline.map { it.kind },
        )
        assertEquals("here is the answer", turn.timeline.last().text)

        // Turn settles: the trailing text drops out of the pill into the
        // answer; only the pre-tool thought remains a timeline row.
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.append(testChunk(id = "f1", seq = 4, kind = ResultKind.FINAL, isFinal = true))
        turn = assertNotNull(state.turns("custom").firstOrNull())
        assertEquals("here is the answer", turn.answer)
        assertEquals(
            listOf<TimelineItem.Kind>(TimelineItem.Kind.Thought, TimelineItem.Kind.Tool),
            turn.timeline.map { it.kind },
        )
    }

    @Test
    fun `todos extract latest-wins normalize status drop empty content`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.RUNNING))
        // An older todo snapshot, then a newer one (latest wins).
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "t1", seq = 1, kind = ResultKind.TOOL, content = "TodoWrite",
                    meta = metaOf(
                        """{"tool": "TodoWrite", "input": {"todos": [{"content": "old", "status": "pending"}]}}""",
                    ),
                ),
                testChunk(
                    id = "t2", seq = 2, kind = ResultKind.TOOL, content = "TodoWrite",
                    meta = metaOf(
                        """
                        {
                          "tool": "TodoWrite",
                          "input": {
                            "todos": [
                              {"content": "write tests", "status": "TODO_STATUS_IN_PROGRESS", "activeForm": "Writing tests"},
                              {"content": "ship", "status": "completed"},
                              {"content": "", "status": "pending"}
                            ]
                          }
                        }
                        """,
                    ),
                ),
            ),
        )
        val turn = assertNotNull(state.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        val todos = assertNotNull(turn.todos)
        assertEquals(2, todos.size) // empty-content row dropped
        assertEquals(TodoStatus.IN_PROGRESS, todos[0].status)
        assertEquals("Writing tests", todos[0].displayText) // activeForm for in-progress
        assertEquals(TodoStatus.COMPLETED, todos[1].status)
        assertEquals("ship", todos[1].displayText)
        // The TodoWrite tool never shows in the main timeline.
        assertFalse(turn.timeline.any { it.kind == TimelineItem.Kind.Tool })
    }

    @Test
    fun `sub-agent groups nested tools under the agent out of the timeline`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "a1", seq = 1, kind = ResultKind.TOOL, content = "Agent",
                    meta = metaOf(
                        """
                        {
                          "tool": "Agent", "id": "agent-1",
                          "input": {"subagent_type": "explorer", "description": "scan repo", "prompt": "find bugs"}
                        }
                        """,
                    ),
                ),
                // Nested tool inside the sub-agent.
                testChunk(
                    id = "n1", seq = 2, kind = ResultKind.TOOL, content = "Read x",
                    meta = metaOf(
                        """
                        {
                          "tool": "Read", "id": "nested-1", "parentToolUseId": "agent-1",
                          "input": {"file_path": "x.swift"}
                        }
                        """,
                    ),
                ),
                testChunk(
                    id = "nr1", seq = 3, kind = ResultKind.STDOUT, content = "file body",
                    meta = metaOf("""{"toolResultFor": "nested-1", "parentToolUseId": "agent-1"}"""),
                ),
                // The sub-agent's streamed response prose: two adjacent
                // nested deltas coalesce into ONE thought item scoped to
                // the card — never the parent timeline's thought flow.
                testChunk(
                    id = "nd1", seq = 4, kind = ResultKind.DELTA, delta = "Found the bug ",
                    meta = metaOf("""{"parentToolUseId": "agent-1"}"""),
                ),
                testChunk(
                    id = "nd2", seq = 5, kind = ResultKind.DELTA, delta = "in x.swift.",
                    meta = metaOf("""{"parentToolUseId": "agent-1"}"""),
                ),
                // Nested thinking is scoped to the card too.
                testChunk(
                    id = "nt1", seq = 6, kind = ResultKind.PROGRESS, content = "nested reasoning",
                    meta = metaOf("""{"contentType": "thinking", "parentToolUseId": "agent-1"}"""),
                ),
                // The Agent tool's own result.
                testChunk(
                    id = "ar1", seq = 7, kind = ResultKind.STDOUT, content = "found 2 bugs",
                    meta = metaOf("""{"toolResultFor": "agent-1"}"""),
                ),
                testChunk(id = "f1", seq = 8, kind = ResultKind.FINAL, isFinal = true),
            ),
        )
        val turn = assertNotNull(state.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        assertEquals(1, turn.subAgents.size)
        val sub = turn.subAgents[0]
        assertEquals("explorer", sub.subagentType)
        assertEquals("scan repo", sub.description)
        assertEquals("find bugs", sub.prompt)
        assertEquals("found 2 bugs", sub.result)
        assertFalse(sub.isError)
        // Chronological: the tool call, then the coalesced text run,
        // then the thinking block.
        assertEquals(3, sub.nested.size)
        assertEquals("Read", sub.nested[0].toolName)
        assertEquals("file body", sub.nested[0].resultText)
        assertEquals(TimelineItem.Kind.Thought, sub.nested[1].kind)
        assertEquals("Found the bug in x.swift.", sub.nested[1].text)
        assertEquals(TimelineItem.Kind.Thinking(redacted = false), sub.nested[2].kind)
        assertEquals("nested reasoning", sub.nested[2].text)
        // Nothing sub-agent-related leaks into the main timeline.
        assertTrue(turn.timeline.isEmpty())
    }

    @Test
    fun `background sub-agent notification summary is the result and boilerplate never shows`() {
        val agentChunk = testChunk(
            id = "a1", seq = 1, kind = ResultKind.TOOL, content = "Agent",
            meta = metaOf(
                """
                {
                  "tool": "Agent", "id": "agent-1",
                  "input": {"subagent_type": "explorer", "prompt": "count files", "run_in_background": true}
                }
                """,
            ),
        )
        val boilerplate = testChunk(
            id = "r1", seq = 2, kind = ResultKind.STDOUT,
            content = "Async agent launched successfully. agentId: abc123 …",
            meta = metaOf("""{"toolResultFor": "agent-1"}"""),
        )

        // Launched, no notification yet (or an old row where the sidecar
        // dropped it): the boilerplate must NOT surface as the result.
        val running = TranscriptState("sess-1")
        running.upsert(testCommand(status = CommandStatus.RUNNING))
        running.mergeBackfill(commands = emptyList(), chunks = listOf(agentChunk, boilerplate))
        val liveSub = assertNotNull(
            running.turns(KnownAgentType.CLAUDE_CODE).firstOrNull()?.subAgents?.firstOrNull(),
        )
        assertNull(liveSub.result)
        assertFalse(liveSub.isError)

        // Notification landed: its summary is the card's result, and the
        // notification chunk stays out of the main timeline (the
        // meta.tool_use_id drop rule).
        val done = TranscriptState("sess-1")
        done.upsert(testCommand(status = CommandStatus.COMPLETED))
        done.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                agentChunk, boilerplate,
                // The parent's launch-time reply. The real wire emits NO
                // final here — every inner `result` flushes at process
                // exit — so the completion notification below is what
                // separates this preamble from the follow-up answer.
                testChunk(id = "d0", seq = 3, kind = ResultKind.DELTA, delta = "It is running now."),
                // The sub-agent streams AFTER the parent's last top-level
                // tool — its report deltas must render in the card, never
                // glued into the parent's answer (the DeltaSplit nested
                // filter).
                testChunk(
                    id = "ns1", seq = 4, kind = ResultKind.STDOUT, content = "nested tool result",
                    meta = metaOf("""{"toolResultFor": "nested-1", "parentToolUseId": "agent-1"}"""),
                ),
                testChunk(
                    id = "nd1", seq = 5, kind = ResultKind.DELTA, delta = "SUBAGENT REPORT",
                    meta = metaOf("""{"parentToolUseId": "agent-1"}"""),
                ),
                testChunk(
                    id = "n1", seq = 6, kind = ResultKind.PROGRESS, content = "Found 10 files.",
                    meta = metaOf(
                        """{"contentType": "task_notification", "tool_use_id": "agent-1", "status": "completed"}""",
                    ),
                ),
                testChunk(id = "d1", seq = 7, kind = ResultKind.DELTA, delta = "The real answer."),
                testChunk(id = "f0", seq = 8, kind = ResultKind.FINAL, content = "It is running now."),
                testChunk(id = "f1", seq = 9, kind = ResultKind.FINAL, isFinal = true),
            ),
        )
        val turn = assertNotNull(done.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        val sub = assertNotNull(turn.subAgents.firstOrNull())
        assertEquals("Found 10 files.", sub.result)
        assertFalse(sub.isError)
        assertTrue(sub.nested.any { it.kind == TimelineItem.Kind.Thought && it.text == "SUBAGENT REPORT" })
        // The parent's answer is ONLY the post-notification reply; the
        // launch-time reply renders as a preamble thought and the
        // sub-agent's streamed report stays in the card.
        assertEquals("The real answer.", turn.answer)
        assertTrue(turn.timeline.any { it.kind == TimelineItem.Kind.Thought && it.text == "It is running now." })
        assertFalse(turn.timeline.any { it.text.contains("SUBAGENT REPORT") })
    }

    @Test
    fun `stderr result marks the tool row as an error`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "t1", seq = 1, kind = ResultKind.TOOL, content = "Bash",
                    meta = metaOf("""{"tool": "Bash", "id": "toolu_5", "input": {"command": "false"}}"""),
                ),
                testChunk(
                    id = "e1", seq = 2, kind = ResultKind.STDERR, content = "boom",
                    meta = metaOf("""{"toolResultFor": "toolu_5", "exitCode": 1}"""),
                ),
            ),
        )
        val turn = assertNotNull(state.turns("custom").firstOrNull())
        assertEquals(1, turn.timeline.size)
        assertTrue(turn.timeline[0].isError)
        assertEquals(1, turn.timeline[0].exitCode)
    }

    @Test
    fun `answer falls back to final content when no post-tool deltas`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(id = "t1", seq = 1, kind = ResultKind.TOOL, content = "bash ls"),
                testChunk(id = "f1", seq = 2, kind = ResultKind.FINAL, content = "Done.", isFinal = true),
            ),
        )
        val turn = assertNotNull(state.turns(KnownAgentType.CODEX).firstOrNull())
        assertEquals("Done.", turn.answer)
    }

    @Test
    fun `thinking rows render and empty thinking and thinking_tokens do not`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.RUNNING))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "p1", seq = 1, kind = ResultKind.PROGRESS,
                    meta = metaOf("""{"contentType": "thinking_tokens", "estimatedTokens": 450}"""),
                ),
                testChunk(
                    id = "p2", seq = 2, kind = ResultKind.PROGRESS, content = "planning the fix",
                    meta = metaOf("""{"contentType": "thinking"}"""),
                ),
                testChunk(
                    id = "p3", seq = 3, kind = ResultKind.PROGRESS, content = "",
                    meta = metaOf("""{"contentType": "thinking"}"""),
                ),
            ),
        )
        val turn = assertNotNull(state.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        assertEquals(450, turn.thinkingTokens)
        assertEquals(1, turn.timeline.size)
        assertEquals(TimelineItem.Kind.Thinking(redacted = false), turn.timeline[0].kind)
        assertTrue(turn.isRunning)
    }

    @Test
    fun `error chunk sets errorText and a visible timeline row`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.FAILED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(id = "e1", seq = 1, kind = ResultKind.ERROR, content = "exit 1", isFinal = true),
            ),
        )
        val turn = assertNotNull(state.turns("custom").firstOrNull())
        assertEquals("exit 1", turn.errorText)
        assertEquals(TimelineItem.Kind.Error, turn.timeline.firstOrNull()?.kind)
    }

    @Test
    fun `snapshot replaces and older history merges and flips hasMore`() {
        val state = TranscriptState("sess-1")
        state.applySnapshot(
            commands = listOf(testCommand(id = "cmd-2", createdAt = "2026-07-05T11:00:00.000Z")),
            chunks = listOf(testChunk(id = "x", commandId = "cmd-2", seq = 3, kind = ResultKind.DELTA, delta = "hi")),
            hasMore = true,
        )
        assertTrue(state.hasMoreHistory)
        assertEquals("cmd-2", state.oldestCommandId)
        assertEquals(3, state.maxSeq)

        state.mergeOlder(
            commands = listOf(testCommand(id = "cmd-1", createdAt = "2026-07-05T10:00:00.000Z")),
            chunks = listOf(testChunk(id = "y", commandId = "cmd-1", seq = 9, kind = ResultKind.FINAL, isFinal = true)),
            hasMore = false,
        )
        assertFalse(state.hasMoreHistory)
        assertEquals("cmd-1", state.oldestCommandId)
        // Snapshot again drops everything, including seen-id memory.
        state.applySnapshot(commands = emptyList(), chunks = emptyList(), hasMore = false)
        assertTrue(state.commands.isEmpty())
        assertEquals(0, state.maxSeq)
    }

    @Test
    fun `reconnect backfill keeps the window held turns update newer join older are dropped`() {
        val state = TranscriptState("sess-1")
        // A 2-turn tail of a longer session, the last turn still running.
        state.applySnapshot(
            commands = listOf(
                testCommand(id = "cmd-5", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T14:00:00.000Z"),
                testCommand(id = "cmd-6", status = CommandStatus.RUNNING, createdAt = "2026-07-05T15:00:00.000Z"),
            ),
            chunks = listOf(testChunk(id = "a", commandId = "cmd-6", seq = 40, kind = ResultKind.DELTA, delta = "…")),
            hasMore = true,
        )

        // `GET /sessions/:id/chunks` answers with EVERY command in the
        // session: the ancient ones, the held ones (cmd-6 finished while
        // away) and one created while disconnected. Ancient chunks ride
        // along too (seq > afterSeq on a long old turn).
        state.mergeBackfill(
            commands = listOf(
                testCommand(id = "cmd-1", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T10:00:00.000Z"),
                testCommand(id = "cmd-2", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T11:00:00.000Z"),
                testCommand(id = "cmd-5", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T14:00:00.000Z"),
                testCommand(id = "cmd-6", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T15:00:00.000Z"),
                testCommand(id = "cmd-7", status = CommandStatus.RUNNING, createdAt = "2026-07-05T16:00:00.000Z"),
            ),
            chunks = listOf(
                testChunk(id = "b", commandId = "cmd-1", seq = 41, kind = ResultKind.DELTA, delta = "ancient"),
                testChunk(id = "c", commandId = "cmd-6", seq = 41, kind = ResultKind.FINAL, isFinal = true),
                testChunk(id = "d", commandId = "cmd-7", seq = 42, kind = ResultKind.DELTA, delta = "new"),
            ),
        )

        // The window's lower edge did not move: nothing older than cmd-5
        // was let in, so the history pager still has a true cursor.
        assertEquals(listOf("cmd-5", "cmd-6", "cmd-7"), state.commands.map { it.id })
        assertEquals("cmd-5", state.oldestCommandId)
        assertTrue(state.hasMoreHistory)
        // Held turn updated in place; the disconnected-era turn joined.
        assertEquals(CommandStatus.COMPLETED, state.commands[1].status)
        assertTrue(state.isRunning)
        // Chunks follow their turn: dropped with cmd-1, kept for the rest.
        assertNull(state.chunksByCommand["cmd-1"])
        assertEquals(listOf(40, 41), state.chunksByCommand["cmd-6"]?.map { it.seq })
        assertEquals(listOf(42), state.chunksByCommand["cmd-7"]?.map { it.seq })
        assertEquals(42, state.maxSeq)
    }

    @Test
    fun `reconnect backfill into an empty transcript accepts everything`() {
        val state = TranscriptState("sess-1")
        state.mergeBackfill(
            commands = listOf(
                testCommand(id = "cmd-1", status = CommandStatus.COMPLETED, createdAt = "2026-07-05T10:00:00.000Z"),
                testCommand(id = "cmd-2", status = CommandStatus.RUNNING, createdAt = "2026-07-05T11:00:00.000Z"),
            ),
            chunks = listOf(testChunk(id = "x", commandId = "cmd-2", seq = 1, kind = ResultKind.DELTA, delta = "hi")),
        )
        assertEquals(listOf("cmd-1", "cmd-2"), state.commands.map { it.id })
        assertEquals(1, state.chunksByCommand["cmd-2"]?.size)
    }

    @Test
    fun `context snapshot prefers the last iteration and finds the window`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "m1", seq = 1, kind = ResultKind.PROGRESS, content = "",
                    meta = metaOf("""{"model": "claude-opus-4-8"}"""),
                ),
                testChunk(
                    id = "f1", seq = 2, kind = ResultKind.FINAL,
                    meta = metaOf(
                        """
                        {
                          "usage": {
                            "input_tokens": 90000,
                            "iterations": [{"input_tokens": 2000, "cache_read_input_tokens": 28000}]
                          }
                        }
                        """,
                    ),
                    isFinal = true,
                ),
            ),
        )
        val snapshot = assertNotNull(state.contextSnapshot(KnownAgentType.CLAUDE_CODE))
        assertEquals(30_000, snapshot.usedTokens)
        assertEquals(200_000, snapshot.windowInfo?.window)
        val fraction = assertNotNull(snapshot.fraction)
        assertTrue(abs(fraction - 0.15) < 0.0001)
    }

    @Test
    fun `compaction divider plus collapsed summary in timeline and ring snaps to postTokens`() {
        val state = TranscriptState("sess-1")
        state.upsert(testCommand(status = CommandStatus.COMPLETED))
        state.mergeBackfill(
            commands = emptyList(),
            chunks = listOf(
                testChunk(
                    id = "b1", seq = 1, kind = ResultKind.PROGRESS,
                    content = "Compacted 25.8k → 1.9k tokens",
                    meta = metaOf(
                        """{"contentType": "compact_boundary", "preTokens": 25829, "postTokens": 1854, "trigger": "manual"}""",
                    ),
                ),
                testChunk(
                    id = "s1", seq = 2, kind = ResultKind.PROGRESS,
                    content = "This session is being continued. SUMMARY.",
                    meta = metaOf("""{"contentType": "compact_summary"}"""),
                ),
                // The REAL compact final: zero token usage but a non-zero
                // total cost (compaction is a paid API call) — hasUsage
                // counts cost, so an unguarded walk would stop here with a
                // zero context and hide (web) or stale-out (iOS) the ring.
                testChunk(
                    id = "f1", seq = 3, kind = ResultKind.FINAL,
                    meta = metaOf(
                        """
                        {
                          "total_cost_usd": 0.05,
                          "usage": {"input_tokens": 0, "output_tokens": 0, "iterations": []}
                        }
                        """,
                    ),
                    isFinal = true,
                ),
            ),
        )
        val turn = assertNotNull(state.turns(KnownAgentType.CLAUDE_CODE).firstOrNull())
        assertEquals(2, turn.timeline.size)
        assertEquals(TimelineItem.Kind.Compact, turn.timeline[0].kind)
        assertEquals("Compacted 25.8k → 1.9k tokens", turn.timeline[0].text)
        assertEquals(TimelineItem.Kind.CompactSummary, turn.timeline[1].kind)
        assertTrue(turn.answer.isEmpty())
        // The ring snaps to the post-compaction context even though the
        // compact turn's own final carries no usage (its result reports
        // zero and iterations is empty).
        val snapshot = assertNotNull(state.contextSnapshot(KnownAgentType.CLAUDE_CODE))
        assertEquals(1854, snapshot.usedTokens)
    }
}
