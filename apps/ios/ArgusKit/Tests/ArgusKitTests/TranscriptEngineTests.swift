import Testing
@testable import ArgusKit

@Suite("TranscriptState — ingest invariants + turn building")
struct TranscriptEngineTests {
    @Test("chunks dedup by id and order by seq")
    func dedupAndOrder() {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .running))

        // Mutating calls hoisted out of #expect — the macro rewrites its
        // expression into a closure whose captures are immutable.
        let first = TestSupport.chunk(id: "c1", seq: 2, kind: .delta, delta: "b")
        let insertedFirst = state.append(chunk: first)
        let insertedDuplicate = state.append(chunk: first)
        let insertedSecond = state.append(chunk: TestSupport.chunk(id: "c2", seq: 1, kind: .delta, delta: "a"))
        #expect(insertedFirst)
        #expect(!insertedDuplicate)
        #expect(insertedSecond)

        let ordered = state.chunksByCommand["cmd-1"]?.map(\.seq)
        #expect(ordered == [1, 2])
        #expect(state.maxSeq == 2)
    }

    @Test("foreign-session chunks are rejected")
    func rejectsForeignSession() {
        var state = TranscriptState(sessionId: "sess-1")
        let foreign = TestSupport.chunk(sessionId: "sess-OTHER", seq: 1, kind: .delta, delta: "x")
        let inserted = state.append(chunk: foreign)
        #expect(!inserted)
    }

    @Test("command upsert replaces in place and keeps createdAt order")
    func commandUpsert() {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(
            id: "cmd-2", status: .running, createdAt: "2026-07-05T11:00:00.000Z"
        ))
        state.upsert(command: TestSupport.command(
            id: "cmd-1", status: .completed, createdAt: "2026-07-05T10:00:00.000Z"
        ))
        #expect(state.commands.map(\.id) == ["cmd-1", "cmd-2"])
        #expect(state.isRunning)

        state.upsert(command: TestSupport.command(
            id: "cmd-2", status: .completed, createdAt: "2026-07-05T11:00:00.000Z"
        ))
        #expect(!state.isRunning)
        #expect(state.commands.count == 2)
    }

    @Test("status flips never wipe a turn's attachments")
    func attachmentsSurviveStatusFlip() throws {
        var state = TranscriptState(sessionId: "sess-1")
        // Creation carries the attachments…
        state.upsert(command: TestSupport.command(status: .running, attachmentIds: ["att-1"]))
        // …but the finalize command:updated event does NOT (bare
        // CommandService.toDto server-side) — it must not wipe them.
        state.upsert(command: TestSupport.command(status: .completed))
        let turn = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        #expect(turn.status == .completed)
        #expect(turn.attachments.map(\.id) == ["att-1"])

        // A later load that DOES carry attachments stays authoritative.
        state.upsert(command: TestSupport.command(status: .completed, attachmentIds: ["att-1", "att-2"]))
        let reloaded = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        #expect(reloaded.attachments.count == 2)
    }

    @Test("turn building: narration vs answer, tool timeline, usage")
    func turnBuilding() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))

        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(id: "d1", seq: 1, kind: .delta, delta: "let me look"),
            TestSupport.chunk(
                id: "t1", seq: 2, kind: .tool, content: "Read main.swift",
                meta: ["tool": .string("Read"), "id": .string("toolu_1")]
            ),
            TestSupport.chunk(
                id: "o1", seq: 3, kind: .stdout, content: "file contents",
                meta: ["toolResultFor": .string("toolu_1")]
            ),
            TestSupport.chunk(id: "d2", seq: 4, kind: .delta, delta: "The answer is 42."),
            TestSupport.chunk(
                id: "f1", seq: 5, kind: .final, content: "The answer is 42.",
                meta: [
                    "usage": .object([
                        "input_tokens": .number(100),
                        "output_tokens": .number(20),
                    ])
                ],
                isFinal: true
            ),
        ])

        let turn = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        #expect(turn.answer == "The answer is 42.")
        #expect(turn.narration == "let me look")
        #expect(!turn.isRunning)
        // The pre-tool delta interleaves as a thought row; the stdout is
        // PAIRED into the tool row (web parity), not a standalone item.
        #expect(turn.timeline.count == 2)
        #expect(turn.timeline[0].kind == .thought)
        #expect(turn.timeline[0].text == "let me look")
        #expect(turn.timeline[1].kind == .tool)
        #expect(turn.timeline[1].toolName == "Read")
        #expect(turn.timeline[1].resultText == "file contents")
        #expect(turn.usage?.inputTokens == 100)
    }

    @Test("edit tool folds its diff result (isDiff/filePath) into the row")
    func toolDiffPairing() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "t1", seq: 1, kind: .tool, content: "Edit app.swift",
                meta: [
                    "tool": .string("Edit"), "id": .string("toolu_9"),
                    "input": .object(["file_path": .string("app.swift")]),
                ]
            ),
            TestSupport.chunk(
                id: "o1", seq: 2, kind: .stdout, content: "@@ -1 +1 @@\n-old\n+new",
                meta: [
                    "toolResultFor": .string("toolu_9"),
                    "isDiff": .bool(true),
                    "filePath": .string("app.swift"),
                ]
            ),
        ])
        let turn = try #require(state.turns(agentType: "custom").first)
        #expect(turn.timeline.count == 1)
        let tool = turn.timeline[0]
        #expect(tool.toolName == "Edit")
        #expect(tool.isDiff)
        #expect(tool.filePath == "app.swift")
        #expect(tool.diffBody.contains("+new"))
    }

    @Test("intermediate deltas interleave as thought rows between tools")
    func interleavedThoughts() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(id: "d1", seq: 1, kind: .delta, delta: "let me look"),
            TestSupport.chunk(
                id: "t1", seq: 2, kind: .tool, content: "Read a",
                meta: ["tool": .string("Read"), "id": .string("x1")]
            ),
            TestSupport.chunk(id: "d2", seq: 3, kind: .delta, delta: "now edit"),
            TestSupport.chunk(
                id: "t2", seq: 4, kind: .tool, content: "Edit b",
                meta: ["tool": .string("Edit"), "id": .string("x2")]
            ),
            TestSupport.chunk(id: "d3", seq: 5, kind: .delta, delta: "All done."),
            TestSupport.chunk(id: "f1", seq: 6, kind: .final, isFinal: true),
        ])
        let turn = try #require(state.turns(agentType: "custom").first)
        // thought, tool, thought, tool — interleaved by seq. The trailing
        // delta (seq 5 > boundary 4) is the answer, not a thought.
        #expect(turn.timeline.map(\.kind) == [.thought, .tool, .thought, .tool])
        #expect(turn.timeline[0].text == "let me look")
        #expect(turn.timeline[2].text == "now edit")
        #expect(turn.answer == "All done.")
    }

    @Test("tool-narration progress (tool_use_id) is dropped, not a system row")
    func toolNarrationProgressDropped() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "t1", seq: 1, kind: .tool, content: "Bash",
                meta: ["tool": .string("Bash"), "id": .string("x1"),
                       "input": .object(["command": .string("git add .")])]
            ),
            // Claude's task_started description, tagged with tool_use_id —
            // duplicates the tool row, so it must not render.
            TestSupport.chunk(
                id: "p1", seq: 2, kind: .progress, content: "Commit changes",
                meta: ["tool_use_id": .string("x1")]
            ),
        ])
        let turn = try #require(state.turns(agentType: "custom").first)
        #expect(turn.timeline.map(\.kind) == [.tool])
        #expect(!turn.timeline.contains { $0.kind == .system })
    }

    @Test("live turn: trailing text folds into the pill, not the answer body")
    func liveTextFoldsIntoPill() throws {
        var state = TranscriptState(sessionId: "sess-1")
        // Running turn: a thought, a tool, then trailing text still streaming.
        state.upsert(command: TestSupport.command(status: .running))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(id: "d1", seq: 1, kind: .delta, delta: "let me check"),
            TestSupport.chunk(
                id: "t1", seq: 2, kind: .tool, content: "Read a",
                meta: ["tool": .string("Read"), "id": .string("x1")]
            ),
            TestSupport.chunk(id: "d2", seq: 3, kind: .delta, delta: "here is the answer"),
        ])
        var turn = try #require(state.turns(agentType: "custom").first)
        // While live, the trailing delta is a thought (in the pill) and the
        // answer body stays empty — no flash.
        #expect(turn.answer.isEmpty)
        #expect(turn.timeline.map(\.kind) == [.thought, .tool, .thought])
        #expect(turn.timeline.last?.text == "here is the answer")

        // Turn settles: the trailing text drops out of the pill into the
        // answer; only the pre-tool thought remains a timeline row.
        state.upsert(command: TestSupport.command(status: .completed))
        state.append(chunk: TestSupport.chunk(id: "f1", seq: 4, kind: .final, isFinal: true))
        turn = try #require(state.turns(agentType: "custom").first)
        #expect(turn.answer == "here is the answer")
        #expect(turn.timeline.map(\.kind) == [.thought, .tool])
    }

    @Test("todos extract latest-wins, normalize status, drop empty content")
    func todoExtraction() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .running))
        // An older todo snapshot, then a newer one (latest wins).
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "t1", seq: 1, kind: .tool, content: "TodoWrite",
                meta: ["tool": .string("TodoWrite"), "input": .object([
                    "todos": .array([.object(["content": .string("old"), "status": .string("pending")])]),
                ])]
            ),
            TestSupport.chunk(
                id: "t2", seq: 2, kind: .tool, content: "TodoWrite",
                meta: ["tool": .string("TodoWrite"), "input": .object([
                    "todos": .array([
                        .object(["content": .string("write tests"), "status": .string("TODO_STATUS_IN_PROGRESS"),
                                 "activeForm": .string("Writing tests")]),
                        .object(["content": .string("ship"), "status": .string("completed")]),
                        .object(["content": .string(""), "status": .string("pending")]), // dropped
                    ]),
                ])]
            ),
        ])
        let turn = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        let todos = try #require(turn.todos)
        #expect(todos.count == 2) // empty-content row dropped
        #expect(todos[0].status == .inProgress)
        #expect(todos[0].displayText == "Writing tests") // activeForm for in-progress
        #expect(todos[1].status == .completed)
        #expect(todos[1].displayText == "ship")
        // The TodoWrite tool never shows in the main timeline.
        #expect(!turn.timeline.contains { $0.kind == .tool })
    }

    @Test("sub-agent groups nested tools under the agent, out of the timeline")
    func subAgentExtraction() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "a1", seq: 1, kind: .tool, content: "Agent",
                meta: ["tool": .string("Agent"), "id": .string("agent-1"),
                       "input": .object([
                           "subagent_type": .string("explorer"),
                           "description": .string("scan repo"),
                           "prompt": .string("find bugs"),
                       ])]
            ),
            // Nested tool inside the sub-agent.
            TestSupport.chunk(
                id: "n1", seq: 2, kind: .tool, content: "Read x",
                meta: ["tool": .string("Read"), "id": .string("nested-1"),
                       "parentToolUseId": .string("agent-1"),
                       "input": .object(["file_path": .string("x.swift")])]
            ),
            TestSupport.chunk(
                id: "nr1", seq: 3, kind: .stdout, content: "file body",
                meta: ["toolResultFor": .string("nested-1"), "parentToolUseId": .string("agent-1")]
            ),
            // The sub-agent's streamed response prose: two adjacent
            // nested deltas coalesce into ONE .thought item scoped to
            // the card — never the parent timeline's thought flow.
            TestSupport.chunk(
                id: "nd1", seq: 4, kind: .delta, delta: "Found the bug ",
                meta: ["parentToolUseId": .string("agent-1")]
            ),
            TestSupport.chunk(
                id: "nd2", seq: 5, kind: .delta, delta: "in x.swift.",
                meta: ["parentToolUseId": .string("agent-1")]
            ),
            // Nested thinking is scoped to the card too.
            TestSupport.chunk(
                id: "nt1", seq: 6, kind: .progress, content: "nested reasoning",
                meta: ["contentType": .string("thinking"), "parentToolUseId": .string("agent-1")]
            ),
            // The Agent tool's own result.
            TestSupport.chunk(
                id: "ar1", seq: 7, kind: .stdout, content: "found 2 bugs",
                meta: ["toolResultFor": .string("agent-1")]
            ),
            TestSupport.chunk(id: "f1", seq: 8, kind: .final, isFinal: true),
        ])
        let turn = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        #expect(turn.subAgents.count == 1)
        let sub = turn.subAgents[0]
        #expect(sub.subagentType == "explorer")
        #expect(sub.description == "scan repo")
        #expect(sub.prompt == "find bugs")
        #expect(sub.result == "found 2 bugs")
        #expect(!sub.isError)
        // Chronological: the tool call, then the coalesced text run,
        // then the thinking block.
        #expect(sub.nested.count == 3)
        #expect(sub.nested[0].toolName == "Read")
        #expect(sub.nested[0].resultText == "file body")
        #expect(sub.nested[1].kind == .thought)
        #expect(sub.nested[1].text == "Found the bug in x.swift.")
        #expect(sub.nested[2].kind == .thinking(redacted: false))
        #expect(sub.nested[2].text == "nested reasoning")
        // Nothing sub-agent-related leaks into the main timeline.
        #expect(turn.timeline.isEmpty)
    }

    @Test("background sub-agent: notification summary is the result, boilerplate never shows")
    func backgroundSubAgentResult() throws {
        let agentChunk = TestSupport.chunk(
            id: "a1", seq: 1, kind: .tool, content: "Agent",
            meta: ["tool": .string("Agent"), "id": .string("agent-1"),
                   "input": .object([
                       "subagent_type": .string("explorer"),
                       "prompt": .string("count files"),
                       "run_in_background": .bool(true),
                   ])]
        )
        let boilerplate = TestSupport.chunk(
            id: "r1", seq: 2, kind: .stdout,
            content: "Async agent launched successfully. agentId: abc123 …",
            meta: ["toolResultFor": .string("agent-1")]
        )

        // Launched, no notification yet (or an old row where the sidecar
        // dropped it): the boilerplate must NOT surface as the result.
        var running = TranscriptState(sessionId: "sess-1")
        running.upsert(command: TestSupport.command(status: .running))
        running.mergeBackfill(commands: [], chunks: [agentChunk, boilerplate])
        let liveSub = try #require(
            running.turns(agentType: KnownAgentType.claudeCode).first?.subAgents.first
        )
        #expect(liveSub.result == nil)
        #expect(!liveSub.isError)

        // Notification landed: its summary is the card's result, and the
        // notification chunk stays out of the main timeline (the
        // meta.tool_use_id drop rule).
        var done = TranscriptState(sessionId: "sess-1")
        done.upsert(command: TestSupport.command(status: .completed))
        done.mergeBackfill(commands: [], chunks: [
            agentChunk, boilerplate,
            // The parent's launch-time reply. The real wire emits NO
            // final here — every inner `result` flushes at process
            // exit — so the completion notification below is what
            // separates this preamble from the follow-up answer.
            TestSupport.chunk(id: "d0", seq: 3, kind: .delta, delta: "It is running now."),
            // The sub-agent streams AFTER the parent's last top-level
            // tool — its report deltas must render in the card, never
            // glued into the parent's answer (the DeltaSplit nested
            // filter).
            TestSupport.chunk(
                id: "ns1", seq: 4, kind: .stdout, content: "nested tool result",
                meta: ["toolResultFor": .string("nested-1"),
                       "parentToolUseId": .string("agent-1")]
            ),
            TestSupport.chunk(
                id: "nd1", seq: 5, kind: .delta, delta: "SUBAGENT REPORT",
                meta: ["parentToolUseId": .string("agent-1")]
            ),
            TestSupport.chunk(
                id: "n1", seq: 6, kind: .progress, content: "Found 10 files.",
                meta: ["contentType": .string("task_notification"),
                       "tool_use_id": .string("agent-1"),
                       "status": .string("completed")]
            ),
            TestSupport.chunk(id: "d1", seq: 7, kind: .delta, delta: "The real answer."),
            TestSupport.chunk(id: "f0", seq: 8, kind: .final, content: "It is running now."),
            TestSupport.chunk(id: "f1", seq: 9, kind: .final, isFinal: true),
        ])
        let turn = try #require(done.turns(agentType: KnownAgentType.claudeCode).first)
        let sub = try #require(turn.subAgents.first)
        #expect(sub.result == "Found 10 files.")
        #expect(!sub.isError)
        #expect(sub.nested.contains { $0.kind == .thought && $0.text == "SUBAGENT REPORT" })
        // The parent's answer is ONLY the post-notification reply; the
        // launch-time reply renders as a preamble thought and the
        // sub-agent's streamed report stays in the card.
        #expect(turn.answer == "The real answer.")
        #expect(turn.timeline.contains { $0.kind == .thought && $0.text == "It is running now." })
        #expect(!turn.timeline.contains { $0.text.contains("SUBAGENT REPORT") })
    }

    @Test("stderr result marks the tool row as an error")
    func toolErrorPairing() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "t1", seq: 1, kind: .tool, content: "Bash",
                meta: [
                    "tool": .string("Bash"), "id": .string("toolu_5"),
                    "input": .object(["command": .string("false")]),
                ]
            ),
            TestSupport.chunk(
                id: "e1", seq: 2, kind: .stderr, content: "boom",
                meta: ["toolResultFor": .string("toolu_5"), "exitCode": .number(1)]
            ),
        ])
        let turn = try #require(state.turns(agentType: "custom").first)
        #expect(turn.timeline.count == 1)
        #expect(turn.timeline[0].isError)
        #expect(turn.timeline[0].exitCode == 1)
    }

    @Test("answer falls back to final content when no post-tool deltas")
    func answerFallback() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(id: "t1", seq: 1, kind: .tool, content: "bash ls"),
            TestSupport.chunk(id: "f1", seq: 2, kind: .final, content: "Done.", isFinal: true),
        ])
        let turn = try #require(state.turns(agentType: KnownAgentType.codex).first)
        #expect(turn.answer == "Done.")
    }

    @Test("thinking rows render; empty thinking and thinking_tokens do not")
    func thinkingHandling() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .running))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "p1", seq: 1, kind: .progress,
                meta: [
                    "contentType": .string("thinking_tokens"),
                    "estimatedTokens": .number(450),
                ]
            ),
            TestSupport.chunk(
                id: "p2", seq: 2, kind: .progress, content: "planning the fix",
                meta: ["contentType": .string("thinking")]
            ),
            TestSupport.chunk(
                id: "p3", seq: 3, kind: .progress, content: "",
                meta: ["contentType": .string("thinking")]
            ),
        ])
        let turn = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        #expect(turn.thinkingTokens == 450)
        #expect(turn.timeline.count == 1)
        #expect(turn.timeline[0].kind == .thinking(redacted: false))
        #expect(turn.isRunning)
    }

    @Test("error chunk sets errorText and a visible timeline row")
    func errorHandling() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .failed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(id: "e1", seq: 1, kind: .error, content: "exit 1", isFinal: true)
        ])
        let turn = try #require(state.turns(agentType: "custom").first)
        #expect(turn.errorText == "exit 1")
        #expect(turn.timeline.first?.kind == .error)
    }

    @Test("snapshot replaces; older history merges and flips hasMore")
    func snapshotAndHistory() {
        var state = TranscriptState(sessionId: "sess-1")
        state.applySnapshot(
            commands: [TestSupport.command(id: "cmd-2", createdAt: "2026-07-05T11:00:00.000Z")],
            chunks: [TestSupport.chunk(id: "x", commandId: "cmd-2", seq: 3, kind: .delta, delta: "hi")],
            hasMore: true
        )
        #expect(state.hasMoreHistory)
        #expect(state.oldestCommandId == "cmd-2")
        #expect(state.maxSeq == 3)

        state.mergeOlder(
            commands: [TestSupport.command(id: "cmd-1", createdAt: "2026-07-05T10:00:00.000Z")],
            chunks: [TestSupport.chunk(id: "y", commandId: "cmd-1", seq: 9, kind: .final, isFinal: true)],
            hasMore: false
        )
        #expect(!state.hasMoreHistory)
        #expect(state.oldestCommandId == "cmd-1")
        // Snapshot again drops everything, including seen-id memory.
        state.applySnapshot(commands: [], chunks: [], hasMore: false)
        #expect(state.commands.isEmpty)
        #expect(state.maxSeq == 0)
    }

    @Test("context snapshot prefers iterations[-1] and finds the window")
    func contextSnapshot() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "m1", seq: 1, kind: .progress, content: "",
                meta: ["model": .string("claude-opus-4-8")]
            ),
            TestSupport.chunk(
                id: "f1", seq: 2, kind: .final,
                meta: [
                    "usage": .object([
                        "input_tokens": .number(90_000),
                        "iterations": .array([
                            .object([
                                "input_tokens": .number(2_000),
                                "cache_read_input_tokens": .number(28_000),
                            ])
                        ]),
                    ])
                ],
                isFinal: true
            ),
        ])
        let snapshot = try #require(state.contextSnapshot(agentType: KnownAgentType.claudeCode))
        #expect(snapshot.usedTokens == 30_000)
        #expect(snapshot.windowInfo?.window == 200_000)
        let fraction = try #require(snapshot.fraction)
        #expect(abs(fraction - 0.15) < 0.0001)
    }
}

    @Test("compaction: divider + collapsed summary in timeline, ring snaps to postTokens")
    func compactFlow() throws {
        var state = TranscriptState(sessionId: "sess-1")
        state.upsert(command: TestSupport.command(status: .completed))
        state.mergeBackfill(commands: [], chunks: [
            TestSupport.chunk(
                id: "b1", seq: 1, kind: .progress,
                content: "Compacted 25.8k → 1.9k tokens",
                meta: ["contentType": .string("compact_boundary"),
                       "preTokens": .number(25829), "postTokens": .number(1854),
                       "trigger": .string("manual")]
            ),
            TestSupport.chunk(
                id: "s1", seq: 2, kind: .progress,
                content: "This session is being continued. SUMMARY.",
                meta: ["contentType": .string("compact_summary")]
            ),
            TestSupport.chunk(id: "f1", seq: 3, kind: .final, isFinal: true),
        ])
        let turn = try #require(state.turns(agentType: KnownAgentType.claudeCode).first)
        #expect(turn.timeline.count == 2)
        #expect(turn.timeline[0].kind == .compact)
        #expect(turn.timeline[0].text == "Compacted 25.8k → 1.9k tokens")
        #expect(turn.timeline[1].kind == .compactSummary)
        #expect(turn.answer.isEmpty)
        // The ring snaps to the post-compaction context even though the
        // compact turn's own final carries no usage (its result reports
        // zero and iterations is empty).
        let snapshot = try #require(state.contextSnapshot(agentType: KnownAgentType.claudeCode))
        #expect(snapshot.usedTokens == 1854)
    }
