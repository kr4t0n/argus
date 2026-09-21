package app.argus.core.engine

import app.argus.core.engine.SearchSnippet.Run
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/SearchSnippetTests.swift —
// "SearchSnippet — the web palette's renderSnippet, over [[hl]] sentinels".

class SearchSnippetTest {
    /** One marked term splits into plain / highlighted / plain. */
    @Test
    fun basicSplit() {
        val runs = SearchSnippet.runs("fix the [[hl]]sidebar[[/hl]] toggle")
        assertEquals(
            listOf(
                Run(text = "fix the ", highlighted = false),
                Run(text = "sidebar", highlighted = true),
                Run(text = " toggle", highlighted = false),
            ),
            runs,
        )
    }

    /** Several marks, including one at the very start and end. */
    @Test
    fun multipleMarks() {
        val runs = SearchSnippet.runs("[[hl]]a[[/hl]] and [[hl]]b[[/hl]]")
        assertEquals(
            listOf(
                Run(text = "a", highlighted = true),
                Run(text = " and ", highlighted = false),
                Run(text = "b", highlighted = true),
            ),
            runs,
        )
    }

    /** An unpaired start marker is literal text, not a swallowed tail. */
    @Test
    fun unpairedStart() {
        assertEquals(
            listOf(Run(text = "no close [[hl]]here", highlighted = false)),
            SearchSnippet.runs("no close [[hl]]here"),
        )
    }

    /** A stray stop marker before any start is literal text. */
    @Test
    fun unpairedStop() {
        assertEquals(
            listOf(
                Run(text = "stray [[/hl]] then ", highlighted = false),
                Run(text = "ok", highlighted = true),
            ),
            SearchSnippet.runs("stray [[/hl]] then [[hl]]ok[[/hl]]"),
        )
    }

    /** Whitespace and newlines collapse so a row stays two lines tall. */
    @Test
    fun whitespaceCollapses() {
        assertEquals(
            listOf(
                Run(text = "first line ", highlighted = false),
                Run(text = "x", highlighted = true),
            ),
            SearchSnippet.runs("  first\n\n  line\t[[hl]]x[[/hl]]\n"),
        )
    }

    /** Empty and marker-only input. */
    @Test
    fun degenerate() {
        assertTrue(SearchSnippet.runs("").isEmpty())
        assertTrue(SearchSnippet.runs("[[hl]][[/hl]]").isEmpty())
    }

    /** Sentinels match shared-types SEARCH_HL_START / SEARCH_HL_STOP. */
    @Test
    fun sentinels() {
        assertEquals("[[hl]]", SearchSnippet.highlightStart)
        assertEquals("[[/hl]]", SearchSnippet.highlightStop)
    }
}
