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
