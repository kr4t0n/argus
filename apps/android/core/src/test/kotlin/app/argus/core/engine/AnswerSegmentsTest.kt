package app.argus.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals

class AnswerSegmentsTest {
    @Test
    fun `a closed mermaid fence becomes a Fence segment between markdown`() {
        val source = "Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nOutro"
        assertEquals(
            listOf(
                AnswerSegment.Markdown("Intro"),
                AnswerSegment.Fence("mermaid", "flowchart LR\n  A --> B"),
                AnswerSegment.Markdown("Outro"),
            ),
            AnswerSegments.split(source),
        )
    }

    @Test
    fun `an unclosed renderable fence stays in the markdown while streaming`() {
        val source = "Intro\n\n```mermaid\nflowchart LR\n  A --> B"
        assertEquals(listOf(AnswerSegment.Markdown(source)), AnswerSegments.split(source))
    }

    @Test
    fun `non-renderable fences are left for the markdown engine, even when closed`() {
        val source = "```bash\nls \$HOME\n```"
        assertEquals(listOf(AnswerSegment.Markdown(source)), AnswerSegments.split(source))
    }

    @Test
    fun `html fences render and the language is lowercased`() {
        val source = "```HTML\n<b>hi</b>\n```"
        assertEquals(listOf(AnswerSegment.Fence("html", "<b>hi</b>")), AnswerSegments.split(source))
    }

    @Test
    fun `a standalone image paragraph is extracted, an inline one is not`() {
        val source = "See:\n\n![Preview](docs/preview.png \"title\")\n\nInline ![x](a.png) stays."
        assertEquals(
            listOf(
                AnswerSegment.Markdown("See:"),
                AnswerSegment.Image(source = "docs/preview.png", alt = "Preview"),
                AnswerSegment.Markdown("Inline ![x](a.png) stays."),
            ),
            AnswerSegments.split(source),
        )
    }

    @Test
    fun `display math is its own segment and adjacent markdown merges`() {
        val source = "Before \$x\$ here.\n\n\$\$\nE = mc^2\n\$\$\n\nAfter"
        assertEquals(
            listOf(
                AnswerSegment.Markdown("Before \$x\$ here."),
                AnswerSegment.DisplayMath("E = mc^2"),
                AnswerSegment.Markdown("After"),
            ),
            AnswerSegments.split(source),
        )
    }

    @Test
    fun `a math-bearing list is re-emitted as markdown with its source markers`() {
        val source = "- first \$a\$\n- second"
        val segments = AnswerSegments.split(source)
        assertEquals(1, segments.size)
        assertEquals(AnswerSegment.Markdown("- first \$a\$\n- second"), segments[0])
    }

    @Test
    fun `fences inside a mermaid block do not confuse the closer search`() {
        val source = "```mermaid\ngraph TD\n```\n\n```html\n<p>x</p>\n```"
        assertEquals(
            listOf(AnswerSegment.Fence("mermaid", "graph TD"), AnswerSegment.Fence("html", "<p>x</p>")),
            AnswerSegments.split(source),
        )
    }
}

class MarkwonMathTest {
    @Test
    fun `single-dollar inline math becomes the engine's double-dollar form`() {
        assertEquals("given \$\$x\$\$ and \$\$h_2\$\$ here", MarkwonMath.rewriteInline("given \$x\$ and \$h_2\$ here"))
    }

    @Test
    fun `fenced code and escaped dollars are untouched`() {
        val source = "```sh\necho \$HOME and \$x\$\n```\ncost \\\$5 and \\\$10"
        assertEquals(source, MarkwonMath.rewriteInline(source))
    }

    @Test
    fun `a line opening a display block passes through`() {
        assertEquals("\$\$\nE=mc^2", MarkwonMath.rewriteInline("\$\$\nE=mc^2"))
    }

    @Test
    fun `text without dollars is returned as-is`() {
        val source = "plain **bold** text"
        assertEquals(source, MarkwonMath.rewriteInline(source))
    }
}
