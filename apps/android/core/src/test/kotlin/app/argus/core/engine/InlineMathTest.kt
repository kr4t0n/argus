package app.argus.core.engine

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Port of ArgusKit `InlineMathTests.swift` — `$…$` run extraction with
 * web (micromark) parity. Every Swift `$` is `\$` here.
 */
class InlineMathTest {
    @Test
    fun `no dollars - one text run`() {
        assertEquals(listOf<InlineMathRun>(InlineMathRun.Text("plain prose")), InlineMath.runs("plain prose"))
    }

    @Test
    fun `simple span splits into text, math, text`() {
        assertEquals(
            listOf<InlineMathRun>(
                InlineMathRun.Text("keep "),
                InlineMathRun.Math("R(x,y)\\in\\{0,1\\}"),
                InlineMathRun.Text(", then SFT"),
            ),
            InlineMath.runs("keep \$R(x,y)\\in\\{0,1\\}\$, then SFT"),
        )
    }

    @Test
    fun `the accepted web false positive - 5 dollars and then 10 dollars mathifies`() {
        assertEquals(
            listOf<InlineMathRun>(
                InlineMathRun.Text("costs "),
                InlineMathRun.Math("5 and then "),
                InlineMathRun.Text("10 more"),
            ),
            InlineMath.runs("costs \$5 and then \$10 more"),
        )
    }

    @Test
    fun `mid-paragraph double-dollar span is an inline span with a double-length closer`() {
        assertEquals(
            listOf<InlineMathRun>(
                InlineMathRun.Text("so "),
                InlineMathRun.Math("E=mc^2"),
                InlineMathRun.Text(" holds"),
            ),
            InlineMath.runs("so \$\$E=mc^2\$\$ holds"),
        )
    }

    @Test
    fun `mismatched dollar runs keep scanning like micromark`() {
        assertEquals(listOf<InlineMathRun>(InlineMathRun.Math("a\$\$b")), InlineMath.runs("\$a\$\$b\$"))
    }

    @Test
    fun `backtick code spans shield their dollars`() {
        assertEquals(
            listOf<InlineMathRun>(
                InlineMathRun.Text("run `echo \$\$` for "),
                InlineMathRun.Math("x"),
            ),
            InlineMath.runs("run `echo \$\$` for \$x\$"),
        )
        assertEquals(listOf<InlineMathRun>(InlineMathRun.Text("`\$a` and `\$b`")), InlineMath.runs("`\$a` and `\$b`"))
    }

    @Test
    fun `escaped backslash-dollar is a literal, never a delimiter`() {
        assertEquals(
            listOf<InlineMathRun>(
                InlineMathRun.Text("pay \\\$5 for "),
                InlineMathRun.Math("x"),
            ),
            InlineMath.runs("pay \\\$5 for \$x\$"),
        )
    }

    @Test
    fun `unclosed or empty spans stay text`() {
        assertEquals(listOf<InlineMathRun>(InlineMathRun.Text("lone \$ dangling")), InlineMath.runs("lone \$ dangling"))
        assertEquals(listOf<InlineMathRun>(InlineMathRun.Text("empty \$\$ here")), InlineMath.runs("empty \$\$ here"))
        assertEquals(listOf<InlineMathRun>(InlineMathRun.Text("blank \$ \$ span")), InlineMath.runs("blank \$ \$ span"))
    }

    @Test
    fun `containsMath mirrors runs`() {
        assertTrue(InlineMath.containsMath("has \$x\$"))
        assertFalse(InlineMath.containsMath("has `\$x\$` only"))
        assertFalse(InlineMath.containsMath("no dollars"))
    }
}
