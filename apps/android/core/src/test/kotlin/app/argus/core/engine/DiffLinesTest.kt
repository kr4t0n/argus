package app.argus.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals

class DiffLinesTest {
    private val sample = """
        --- a/src/foo.go
        +++ b/src/foo.go
        @@ -1,3 +1,4 @@
         package foo
        -func old() {}
        +func new() {}
        +func extra() {}
        \ No newline at end of file
    """.trimIndent() + "\n"

    @Test
    fun `lines are classified and a trailing newline adds no empty line`() {
        val lines = DiffLines.parse(sample)
        assertEquals(
            listOf(
                DiffLineKind.META, DiffLineKind.META, DiffLineKind.HUNK, DiffLineKind.CONTEXT,
                DiffLineKind.REMOVE, DiffLineKind.ADD, DiffLineKind.ADD, DiffLineKind.META,
            ),
            lines.map { it.kind },
        )
        assertEquals("-func old() {}", lines[4].text)
    }

    @Test
    fun `file headers are meta, not add or remove`() {
        assertEquals(DiffLineKind.META, DiffLines.classify("--- a/x"))
        assertEquals(DiffLineKind.META, DiffLines.classify("+++ b/x"))
        assertEquals(DiffLineKind.REMOVE, DiffLines.classify("--"))
        assertEquals(DiffLineKind.ADD, DiffLines.classify("+"))
    }

    @Test
    fun `counts tally only real changes`() {
        assertEquals(DiffCounts(added = 2, removed = 1), DiffLines.counts(sample))
        assertEquals(DiffCounts(0, 0), DiffLines.counts(""))
    }
}
