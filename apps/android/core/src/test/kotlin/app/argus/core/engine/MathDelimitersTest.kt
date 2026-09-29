package app.argus.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Port of ArgusKit `MathDelimitersTests.swift` — Codex bracket math
 * folded to dollar delimiters. Every Swift `"\\["` is the same Kotlin
 * escape (backslash + bracket); every Swift `$` is `\$` here.
 */
class MathDelimitersTest {
    @Test
    fun `the observed Codex shape - multi-line bracket display math becomes a double-dollar block`() {
        val source = "The formulation is:\n\n\\[\nr_\\text{aes}(x)\n\\]\n\nTrain it."
        val want = "The formulation is:\n\n\$\$\nr_\\text{aes}(x)\n\$\$\n\nTrain it."
        assertEquals(want, MathDelimiters.normalize(source))
    }

    @Test
    fun `inline bracket spans become single-dollar spans`() {
        assertEquals("given \$x\$ and \$h\$ here", MathDelimiters.normalize("given \\(x\\) and \\(h\\) here"))
        assertEquals("\$a\$+\$b\$", MathDelimiters.normalize("\\(a\\)+\\(b\\)"))
    }

    @Test
    fun `underscores inside survive - the whole point of the pass`() {
        val source = "\\[R = w_a R_\\text{aes} + w_c R_\\text{leg}\\]"
        assertEquals("\$\$R = w_a R_\\text{aes} + w_c R_\\text{leg}\$\$", MathDelimiters.normalize(source))
    }

    @Test
    fun `unclosed opener stays raw mid-stream, converts once the closer lands`() {
        assertEquals("mid stream \\[\nr(x)", MathDelimiters.normalize("mid stream \\[\nr(x)"))
        assertEquals("mid stream \$\$\nr(x)\n\$\$", MathDelimiters.normalize("mid stream \\[\nr(x)\n\\]"))
    }

    @Test
    fun `a lone escaped bracket from CommonMark is left alone`() {
        assertEquals("a literal \\[ bracket", MathDelimiters.normalize("a literal \\[ bracket"))
        assertEquals("a literal \\( paren", MathDelimiters.normalize("a literal \\( paren"))
        // `\\]` is an escaped backslash then `]` — not a closer.
        assertEquals("\\\\[not math\\\\]", MathDelimiters.normalize("\\\\[not math\\\\]"))
    }

    @Test
    fun `fenced code is immune - the real find dot backslash-paren false positive`() {
        val shell = "```bash\nfind . \\( -name \"*.h\" \\) -print\n```"
        assertEquals(shell, MathDelimiters.normalize(shell))
        val tilde = "~~~\n\\[x\\]\n~~~"
        assertEquals(tilde, MathDelimiters.normalize(tilde))
        // …and text after the fence closes is still rewritten.
        assertEquals("```\n\\[a\\]\n```\n\$b\$", MathDelimiters.normalize("```\n\\[a\\]\n```\n\\(b\\)"))
    }

    @Test
    fun `backtick code spans are immune`() {
        assertEquals("use `\\(x\\)` inline", MathDelimiters.normalize("use `\\(x\\)` inline"))
        assertEquals("`a` then \$x\$", MathDelimiters.normalize("`a` then \\(x\\)"))
    }

    @Test
    fun `empty, dollar-bearing, and blank-line-split spans are skipped`() {
        assertEquals("\\[\\]", MathDelimiters.normalize("\\[\\]"))
        assertEquals("\\[   \\]", MathDelimiters.normalize("\\[   \\]"))
        assertEquals("\\[a \$ b\\]", MathDelimiters.normalize("\\[a \$ b\\]"))
        assertEquals("\\[a\n\nb\\]", MathDelimiters.normalize("\\[a\n\nb\\]"))
    }

    @Test
    fun `text with no bracket delimiters comes back identical`() {
        val plain = "plain \$x\$ and **bold** and a \\_escape\\_"
        assertEquals(plain, MathDelimiters.normalize(plain))
    }

    @Test
    fun `end to end - MathSegments turns Codex brackets into real segments`() {
        val answer = "Intro:\n\n\\[\nE = mc^2\n\\]\n\nand inline \\(x\\) too."
        assertEquals(
            listOf<MathSegment>(
                // Trailing blank line rides the markdown run, as in MathSegmentsTest.
                MathSegment.Markdown("Intro:\n"),
                MathSegment.DisplayMath("E = mc^2"),
                MathSegment.InlineParagraph("and inline \$x\$ too."),
            ),
            MathSegments.split(answer),
        )
    }
}
