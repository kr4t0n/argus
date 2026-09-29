package app.argus.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Port of ArgusKit `MathSegmentsTests.swift` — `$$` display-math
 * extraction for the transcript. Every Swift `$` is `\$` here; the
 * Swift multi-line literals are written out with explicit `\n`s (they
 * carry no trailing newline).
 */
class MathSegmentsTest {
    @Test
    fun `no dollars - single markdown segment, text untouched`() {
        val text = "Just prose, no math anywhere.\n\n- a list\n- of things"
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(text)), MathSegments.split(text))
    }

    @Test
    fun `plain paragraph with inline dollar math becomes InlineParagraph`() {
        val text = "Sample \$y \\sim \\pi_{\\theta_0}(\\cdot|x)\$, keep \$R(x,y)\\in\\{0,1\\}\$, then SFT:"
        assertEquals(listOf<MathSegment>(MathSegment.InlineParagraph(text)), MathSegments.split(text))
    }

    @Test
    fun `flat bullet list with math becomes InlineList`() {
        val list = "- where \$\\pi_\\theta\$ is the policy\n- and \$R\$ the reward"
        assertEquals(
            listOf<MathSegment>(
                MathSegment.InlineList(
                    listOf(
                        MathListItem(marker = "-", text = "where \$\\pi_\\theta\$ is the policy"),
                        MathListItem(marker = "-", text = "and \$R\$ the reward"),
                    ),
                ),
            ),
            MathSegments.split(list),
        )
    }

    @Test
    fun `ordered list with math keeps its numbering tokens`() {
        val list = "1. sample \$y\$\n2) filter \$R\$"
        assertEquals(
            listOf<MathSegment>(
                MathSegment.InlineList(
                    listOf(
                        MathListItem(marker = "1.", text = "sample \$y\$"),
                        MathListItem(marker = "2)", text = "filter \$R\$"),
                    ),
                ),
            ),
            MathSegments.split(list),
        )
    }

    @Test
    fun `the on-device regression - bold plus math inside a bullet`() {
        val list = "- **On-policy REINFORCE** (binary reward): " +
            "\$\\mathbb{E}_{y\\sim\\pi_\\theta}[R(y)\\nabla_\\theta \\log \\pi_\\theta(y)]\$"
        val segments = MathSegments.split(list)
        assertEquals(1, segments.size, "expected one InlineList, got $segments")
        val first = segments[0]
        assertTrue(first is MathSegment.InlineList, "expected one InlineList, got $segments")
        val items = (first as MathSegment.InlineList).items
        assertEquals(1, items.size)
        // Underscores must survive verbatim — the markdown parser ate them
        // when this block fell through to it.
        assertTrue(items[0].text.contains("\\mathbb{E}_{y\\sim\\pi_\\theta}"))
    }

    @Test
    fun `lazy continuation lines join into the item`() {
        val list = "- first line with \$x\$\n  continues here"
        assertEquals(
            listOf<MathSegment>(
                MathSegment.InlineList(
                    listOf(MathListItem(marker = "-", text = "first line with \$x\$\ncontinues here")),
                ),
            ),
            MathSegments.split(list),
        )
    }

    @Test
    fun `lists without math, nested lists, and headings stay raw markdown`() {
        val plain = "- no math here\n- none here either"
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(plain + " \$ ")), MathSegments.split(plain + " \$ "))
        val nested = "- outer \$x\$\n  - inner \$y\$"
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(nested)), MathSegments.split(nested))
        val heading = "## About \$\\pi_\\theta\$"
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(heading)), MathSegments.split(heading))
    }

    @Test
    fun `dollars only inside backtick code spans stay markdown`() {
        val text = "Use `\$PATH` and `\$HOME` here."
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(text)), MathSegments.split(text))
    }

    @Test
    fun `mixed answer - text, inline paragraph, display block`() {
        val text = "Intro line.\n\nWith \$x\$ inline.\n\n\$\$\ny = x^2\n\$\$"
        assertEquals(
            listOf<MathSegment>(
                MathSegment.Markdown("Intro line.\n"),
                MathSegment.InlineParagraph("With \$x\$ inline."),
                MathSegment.DisplayMath("y = x^2"),
            ),
            MathSegments.split(text),
        )
    }

    @Test
    fun `fenced double-dollar block splits into text, math, text`() {
        val text = "Before.\n\n\$\$\n\\nabla J = \\mathbb{E}_{y\\sim\\pi_{\\theta_0}}\\big[R(y)\\big]\n\$\$\n\nAfter."
        val segments = MathSegments.split(text)
        assertEquals(
            listOf<MathSegment>(
                MathSegment.Markdown("Before.\n"),
                MathSegment.DisplayMath("\\nabla J = \\mathbb{E}_{y\\sim\\pi_{\\theta_0}}\\big[R(y)\\big]"),
                MathSegment.Markdown("\nAfter."),
            ),
            segments,
        )
    }

    @Test
    fun `single-line double-dollar span is display math - iOS deviation from web, by design`() {
        val segments = MathSegments.split("\$\$E = mc^2\$\$")
        assertEquals(listOf<MathSegment>(MathSegment.DisplayMath("E = mc^2")), segments)
    }

    @Test
    fun `underscores and backslashes survive verbatim`() {
        val segments = MathSegments.split("\$\$\\pi^*_{\\text{RFT}}(y\\mid x)\$\$")
        assertEquals(listOf<MathSegment>(MathSegment.DisplayMath("\\pi^*_{\\text{RFT}}(y\\mid x)")), segments)
    }

    @Test
    fun `double-dollar inside a backtick fence is code, not math`() {
        val text = "Run this:\n\n```bash\necho \$\$\n\$\$\nkill -9 \$\$\n```\n\nDone."
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(text)), MathSegments.split(text))
    }

    @Test
    fun `tilde fence variant is also immune`() {
        val text = "~~~\n\$\$\nnot math\n\$\$\n~~~"
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(text)), MathSegments.split(text))
    }

    @Test
    fun `fence with info string containing no closer keeps double-dollar raw`() {
        val text = "```latex\n\$\$x\$\$\n```"
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(text)), MathSegments.split(text))
    }

    @Test
    fun `unclosed double-dollar mid-stream stays raw markdown until the closer arrives`() {
        val streaming = "So far:\n\n\$\$\n\\frac{a}{b}"
        assertEquals(listOf<MathSegment>(MathSegment.Markdown(streaming)), MathSegments.split(streaming))

        val settled = streaming + "\n\$\$"
        assertEquals(
            listOf<MathSegment>(
                MathSegment.Markdown("So far:\n"),
                MathSegment.DisplayMath("\\frac{a}{b}"),
            ),
            MathSegments.split(settled),
        )
    }

    @Test
    fun `multiple blocks - blank-only gaps produce no empty segments`() {
        val text = "\$\$a\$\$\n\n\$\$\nb\n\$\$"
        assertEquals(
            listOf<MathSegment>(MathSegment.DisplayMath("a"), MathSegment.DisplayMath("b")),
            MathSegments.split(text),
        )
    }

    @Test
    fun `several double-dollar spans on one line go to the inline pass, not display`() {
        val text = "\$\$a\$\$ and \$\$b\$\$"
        assertEquals(listOf<MathSegment>(MathSegment.InlineParagraph(text)), MathSegments.split(text))
    }

    @Test
    fun `empty quadruple-dollar and bare double-dollar pairs are not math`() {
        assertEquals(listOf<MathSegment>(MathSegment.Markdown("\$\$\$\$")), MathSegments.split("\$\$\$\$"))
        assertEquals(listOf<MathSegment>(MathSegment.Markdown("\$\$ \$\$")), MathSegments.split("\$\$ \$\$"))
    }

    @Test
    fun `indented double-dollar fence up to 3 spaces still opens math`() {
        val text = "  \$\$\n  x^2\n  \$\$"
        assertEquals(listOf<MathSegment>(MathSegment.DisplayMath("x^2")), MathSegments.split(text))
    }
}
