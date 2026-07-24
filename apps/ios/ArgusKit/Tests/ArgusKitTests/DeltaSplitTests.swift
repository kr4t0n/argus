import Testing
@testable import ArgusKit

@Suite("DeltaSplit — port of apps/web/src/lib/deltaSplit.ts")
struct DeltaSplitTests {
    @Test("plain Q&A turn: no tools → every delta is final")
    func noToolsAllFinal() {
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .delta, delta: "Hello "),
            TestSupport.chunk(seq: 2, kind: .delta, delta: "world"),
            TestSupport.chunk(seq: 3, kind: .final, content: "Hello world"),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.boundarySeq == -1)
        #expect(split.finalDeltas.count == 2)
        #expect(split.intermediateDeltas.isEmpty)
        #expect(split.finalDeltas.compactMap(\.delta).joined() == "Hello world")
    }

    @Test("tool-use turn: deltas before the last tool are narration")
    func toolBoundarySplits() {
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .delta, delta: "let me check X"),
            TestSupport.chunk(seq: 2, kind: .tool, content: "grep foo"),
            TestSupport.chunk(seq: 3, kind: .stdout, content: "match"),
            TestSupport.chunk(seq: 4, kind: .delta, delta: "now Y"),
            TestSupport.chunk(seq: 5, kind: .tool, content: "read bar"),
            TestSupport.chunk(seq: 6, kind: .delta, delta: "Done. Result is 42."),
            TestSupport.chunk(seq: 7, kind: .final),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.boundarySeq == 5)
        #expect(split.finalDeltas.compactMap(\.delta).joined() == "Done. Result is 42.")
        #expect(split.intermediateDeltas.count == 2)
    }

    @Test("sub-agent-nested chunks are invisible: no boundary moves, no answer join")
    func nestedChunksInvisible() {
        let nested: [String: JSONValue] = ["parentToolUseId": .string("agent-1")]
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .tool, content: "Agent spawn"),
            TestSupport.chunk(seq: 2, kind: .stdout, content: "launched"),
            // Background sub-agent streams AFTER the parent's last
            // top-level tool: its tool result must not become the
            // boundary, and its report deltas must not join the answer.
            TestSupport.chunk(seq: 3, kind: .stdout, content: "nested result", meta: nested),
            TestSupport.chunk(seq: 4, kind: .delta, delta: "SUBAGENT REPORT", meta: nested),
            TestSupport.chunk(seq: 5, kind: .delta, delta: "The real answer."),
            TestSupport.chunk(seq: 6, kind: .final),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.boundarySeq == 2)
        #expect(split.finalDeltas.compactMap(\.delta).joined() == "The real answer.")
        #expect(split.intermediateDeltas.isEmpty)
    }

    @Test("multi-final command: earlier inner turns' text is preamble, not answer")
    func innerTurnFinalsSplit() {
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .delta, delta: "Launching the agent."),
            TestSupport.chunk(seq: 2, kind: .tool, content: "Agent spawn"),
            TestSupport.chunk(seq: 3, kind: .stdout, content: "launched"),
            TestSupport.chunk(seq: 4, kind: .delta, delta: "It is running now."),
            TestSupport.chunk(seq: 5, kind: .final, content: "It is running now."),
            TestSupport.chunk(seq: 6, kind: .delta, delta: "It finished cleanly."),
            TestSupport.chunk(seq: 7, kind: .final, isFinal: true),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.boundarySeq == 5)
        #expect(split.finalDeltas.compactMap(\.delta).joined() == "It finished cleanly.")
        #expect(split.intermediateDeltas.count == 2)
    }

    @Test("real async wire: the notification splits the replies; finals flush at exit")
    func notificationBoundaryRealShape() {
        let nested: [String: JSONValue] = ["parentToolUseId": .string("agent-1")]
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .delta, delta: "Launching."),
            TestSupport.chunk(seq: 2, kind: .tool, content: "Agent spawn"),
            TestSupport.chunk(seq: 3, kind: .stdout, content: "launched"),
            TestSupport.chunk(seq: 4, kind: .delta, delta: "It is running now."),
            TestSupport.chunk(seq: 5, kind: .stdout, content: "nested result", meta: nested),
            TestSupport.chunk(seq: 6, kind: .delta, delta: "SUBAGENT REPORT", meta: nested),
            TestSupport.chunk(
                seq: 7, kind: .progress, content: "the report",
                meta: ["contentType": .string("task_notification"),
                       "tool_use_id": .string("agent-1")]
            ),
            TestSupport.chunk(seq: 8, kind: .delta, delta: "It finished cleanly."),
            // Both inner `result` finals flush at process exit — after
            // every delta — so they can never be the separator.
            TestSupport.chunk(seq: 9, kind: .final, content: "It is running now."),
            TestSupport.chunk(seq: 10, kind: .final, isFinal: true),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.boundarySeq == 7)
        #expect(split.finalDeltas.compactMap(\.delta).joined() == "It finished cleanly.")
        #expect(split.intermediateDeltas.count == 2)
    }

    @Test("old double-final (rich + synthetic exit) keeps the answer intact")
    func trailingSyntheticFinalHarmless() {
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .tool, content: "grep foo"),
            TestSupport.chunk(seq: 2, kind: .stdout, content: "match"),
            TestSupport.chunk(seq: 3, kind: .delta, delta: "The answer."),
            TestSupport.chunk(seq: 4, kind: .final, content: "The answer."),
            // Sidecars ≤ 0.2.7-rc.1: unconditional process-exit final.
            TestSupport.chunk(seq: 5, kind: .final, isFinal: true),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.boundarySeq == 2)
        #expect(split.finalDeltas.compactMap(\.delta).joined() == "The answer.")
    }

    @Test("error chunk also forms a boundary")
    func errorIsBoundary() {
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .delta, delta: "trying"),
            TestSupport.chunk(seq: 2, kind: .error, content: "boom"),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.boundarySeq == 2)
        #expect(split.finalDeltas.isEmpty)
        #expect(split.intermediateDeltas.count == 1)
    }

    @Test("trailing tool with no post-tool deltas → no final deltas")
    func trailingToolNoFinal() {
        let chunks = [
            TestSupport.chunk(seq: 1, kind: .delta, delta: "working"),
            TestSupport.chunk(seq: 2, kind: .tool, content: "bash"),
        ]
        let split = DeltaSplit.split(chunks)
        #expect(split.finalDeltas.isEmpty)
        #expect(split.intermediateDeltas.count == 1)
    }
}
