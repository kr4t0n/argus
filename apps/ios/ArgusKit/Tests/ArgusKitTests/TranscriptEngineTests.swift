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
        #expect(turn.timeline.count == 2)
        #expect(turn.timeline[0].kind == .tool(name: "Read"))
        #expect(turn.timeline[1].toolResultFor == "toolu_1")
        #expect(turn.usage?.inputTokens == 100)
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
