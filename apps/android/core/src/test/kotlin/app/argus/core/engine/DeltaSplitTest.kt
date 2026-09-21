package app.argus.core.engine

import app.argus.core.metaOf
import app.argus.core.model.ResultChunk
import app.argus.core.model.ResultKind
import app.argus.core.testChunk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/DeltaSplitTests.swift.

/** DeltaSplit — port of apps/web/src/lib/deltaSplit.ts. */
class DeltaSplitTest {
    private fun joined(deltas: List<ResultChunk>): String =
        deltas.mapNotNull { it.delta }.joinToString("")

    @Test
    fun `plain QA turn with no tools makes every delta final`() {
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.DELTA, delta = "Hello "),
            testChunk(seq = 2, kind = ResultKind.DELTA, delta = "world"),
            testChunk(seq = 3, kind = ResultKind.FINAL, content = "Hello world"),
        )
        val split = DeltaSplit.split(chunks)
        assertEquals(-1, split.boundarySeq)
        assertEquals(2, split.finalDeltas.size)
        assertTrue(split.intermediateDeltas.isEmpty())
        assertEquals("Hello world", joined(split.finalDeltas))
    }

    @Test
    fun `tool-use turn treats deltas before the last tool as narration`() {
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.DELTA, delta = "let me check X"),
            testChunk(seq = 2, kind = ResultKind.TOOL, content = "grep foo"),
            testChunk(seq = 3, kind = ResultKind.STDOUT, content = "match"),
            testChunk(seq = 4, kind = ResultKind.DELTA, delta = "now Y"),
            testChunk(seq = 5, kind = ResultKind.TOOL, content = "read bar"),
            testChunk(seq = 6, kind = ResultKind.DELTA, delta = "Done. Result is 42."),
            testChunk(seq = 7, kind = ResultKind.FINAL),
        )
        val split = DeltaSplit.split(chunks)
        assertEquals(5, split.boundarySeq)
        assertEquals("Done. Result is 42.", joined(split.finalDeltas))
        assertEquals(2, split.intermediateDeltas.size)
    }

    @Test
    fun `sub-agent-nested chunks are invisible to the split`() {
        val nested = metaOf("""{"parentToolUseId": "agent-1"}""")
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.TOOL, content = "Agent spawn"),
            testChunk(seq = 2, kind = ResultKind.STDOUT, content = "launched"),
            // Background sub-agent streams AFTER the parent's last
            // top-level tool: its tool result must not become the
            // boundary, and its report deltas must not join the answer.
            testChunk(seq = 3, kind = ResultKind.STDOUT, content = "nested result", meta = nested),
            testChunk(seq = 4, kind = ResultKind.DELTA, delta = "SUBAGENT REPORT", meta = nested),
            testChunk(seq = 5, kind = ResultKind.DELTA, delta = "The real answer."),
            testChunk(seq = 6, kind = ResultKind.FINAL),
        )
        val split = DeltaSplit.split(chunks)
        assertEquals(2, split.boundarySeq)
        assertEquals("The real answer.", joined(split.finalDeltas))
        assertTrue(split.intermediateDeltas.isEmpty())
    }

    @Test
    fun `multi-final command treats earlier inner turn text as preamble`() {
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.DELTA, delta = "Launching the agent."),
            testChunk(seq = 2, kind = ResultKind.TOOL, content = "Agent spawn"),
            testChunk(seq = 3, kind = ResultKind.STDOUT, content = "launched"),
            testChunk(seq = 4, kind = ResultKind.DELTA, delta = "It is running now."),
            testChunk(seq = 5, kind = ResultKind.FINAL, content = "It is running now."),
            testChunk(seq = 6, kind = ResultKind.DELTA, delta = "It finished cleanly."),
            testChunk(seq = 7, kind = ResultKind.FINAL, isFinal = true),
        )
        val split = DeltaSplit.split(chunks)
        assertEquals(5, split.boundarySeq)
        assertEquals("It finished cleanly.", joined(split.finalDeltas))
        assertEquals(2, split.intermediateDeltas.size)
    }

    @Test
    fun `real async wire notification splits the replies and finals flush at exit`() {
        val nested = metaOf("""{"parentToolUseId": "agent-1"}""")
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.DELTA, delta = "Launching."),
            testChunk(seq = 2, kind = ResultKind.TOOL, content = "Agent spawn"),
            testChunk(seq = 3, kind = ResultKind.STDOUT, content = "launched"),
            testChunk(seq = 4, kind = ResultKind.DELTA, delta = "It is running now."),
            testChunk(seq = 5, kind = ResultKind.STDOUT, content = "nested result", meta = nested),
            testChunk(seq = 6, kind = ResultKind.DELTA, delta = "SUBAGENT REPORT", meta = nested),
            testChunk(
                seq = 7, kind = ResultKind.PROGRESS, content = "the report",
                meta = metaOf("""{"contentType": "task_notification", "tool_use_id": "agent-1"}"""),
            ),
            testChunk(seq = 8, kind = ResultKind.DELTA, delta = "It finished cleanly."),
            // Both inner `result` finals flush at process exit — after
            // every delta — so they can never be the separator.
            testChunk(seq = 9, kind = ResultKind.FINAL, content = "It is running now."),
            testChunk(seq = 10, kind = ResultKind.FINAL, isFinal = true),
        )
        val split = DeltaSplit.split(chunks)
        assertEquals(7, split.boundarySeq)
        assertEquals("It finished cleanly.", joined(split.finalDeltas))
        assertEquals(2, split.intermediateDeltas.size)
    }

    @Test
    fun `old double-final keeps the answer intact`() {
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.TOOL, content = "grep foo"),
            testChunk(seq = 2, kind = ResultKind.STDOUT, content = "match"),
            testChunk(seq = 3, kind = ResultKind.DELTA, delta = "The answer."),
            testChunk(seq = 4, kind = ResultKind.FINAL, content = "The answer."),
            // Sidecars <= 0.2.7-rc.1: unconditional process-exit final.
            testChunk(seq = 5, kind = ResultKind.FINAL, isFinal = true),
        )
        val split = DeltaSplit.split(chunks)
        assertEquals(2, split.boundarySeq)
        assertEquals("The answer.", joined(split.finalDeltas))
    }

    @Test
    fun `error chunk also forms a boundary`() {
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.DELTA, delta = "trying"),
            testChunk(seq = 2, kind = ResultKind.ERROR, content = "boom"),
        )
        val split = DeltaSplit.split(chunks)
        assertEquals(2, split.boundarySeq)
        assertTrue(split.finalDeltas.isEmpty())
        assertEquals(1, split.intermediateDeltas.size)
    }

    @Test
    fun `trailing tool with no post-tool deltas yields no final deltas`() {
        val chunks = listOf(
            testChunk(seq = 1, kind = ResultKind.DELTA, delta = "working"),
            testChunk(seq = 2, kind = ResultKind.TOOL, content = "bash"),
        )
        val split = DeltaSplit.split(chunks)
        assertTrue(split.finalDeltas.isEmpty())
        assertEquals(1, split.intermediateDeltas.size)
    }
}
