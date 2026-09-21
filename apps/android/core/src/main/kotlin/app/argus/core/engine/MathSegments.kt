package app.argus.core.engine

// Port of ArgusKit `Engine/MathSegments.swift`. There is no TypeScript
// original for the splitter itself — the web reaches the same feature
// through remark-math (`apps/web/src/lib/markdown.ts`) — so the Swift
// file is the source of truth and its delimiter rules (and deliberate
// deviations from the web, listed on [MathSegments]) are what this port
// mirrors. Not ported: `MathCompat.swift`. The Android renderer is
// JLatexMath, whose LaTeX subset makes SwiftMath's rewrites unnecessary
// (docs/plan-android-native-client.md §5); the Swift splitter never
// called it, so the segment model here is complete without it.

/** One piece of an assistant answer after math extraction. */
sealed interface MathSegment {
    /** Ordinary markdown — render with the markdown renderer. */
    data class Markdown(val text: String) : MathSegment

    /** The inside of a `$$…$$` block — render with the math renderer. */
    data class DisplayMath(val latex: String) : MathSegment

    /**
     * A plain paragraph carrying inline `$…$` math — render as an
     * assembled text row with native math spans (see [InlineMath.runs]).
     */
    data class InlineParagraph(val text: String) : MathSegment

    /**
     * A flat (unnested) list whose items carry inline math — render as
     * marker + assembled text rows.
     */
    data class InlineList(val items: List<MathListItem>) : MathSegment
}

/** One item of a flat list that gets the inline-math treatment. */
data class MathListItem(
    /** The literal source marker: `-`, `*`, `+`, or `3.` / `3)`. */
    val marker: String,
    /** Item content; lazy-continuation lines joined with newlines. */
    val text: String,
)

/**
 * Splits answer markdown into text, `$$…$$` display-math, and
 * inline-math-paragraph segments.
 *
 * The markdown renderer has no math extension, so math is extracted
 * BEFORE parsing and rendered natively by the app at the seams this
 * splitter produces (the same seams iOS uses for SwiftMath); the web
 * reaches the same feature through remark-math instead
 * (`apps/web/src/lib/markdown.ts`). Keep the delimiter rules aligned
 * with the web's, with deliberate deviations:
 *
 * - A standalone `$$…$$` single line renders as *display* math here but
 *   *inline* math on the web (micromark treats it as math-text). Claude
 *   emits that shape constantly, and display beats raw dollars.
 * - Inline `$…$` renders in plain paragraphs and FLAT list items
 *   (Claude's math bullets are overwhelmingly flat single-level
 *   lists — and raw list-item dollars don't just look bad, the markdown
 *   parser eats their `_` subscripts as emphasis). Math inside nested
 *   lists, headings, quotes, and tables stays raw — those need
 *   per-block-type text assembly that isn't worth it until they
 *   actually grate. The web renders math everywhere.
 *
 * Bracket delimiters are folded to dollars first ([MathDelimiters]), so
 * every rule below applies to Codex's `\[…\]`/`\(…\)` too.
 *
 * Rules, scanned line by line:
 * - A line that is exactly `$$` (after trimming) opens a block; the
 *   next exactly-`$$` line closes it. Unclosed at end of text → the
 *   would-be opener stays plain markdown, so a *streaming* turn shows
 *   raw source until the closing fence arrives, then snaps to math —
 *   the same self-correction the web has.
 * - A single line of the form `$$…$$` (non-empty inner, no `$$` inside)
 *   is display math on its own.
 * - A blank-line-delimited paragraph whose lines carry no block marker
 *   (heading/list/quote/table/indented code) and which contains at
 *   least one inline span (per [InlineMath]'s web-parity rules, code
 *   spans immune) becomes [MathSegment.InlineParagraph].
 * - Anything inside a ``` / ~~~ code fence is never math — a shell
 *   block's `$$` (PID) must not mathify. Indented (4-space) code blocks
 *   are NOT recognized as fences; a literal `$$` line inside one would
 *   mathify. Accepted: CLIs fence code, indented blocks barely occur.
 */
object MathSegments {
    fun split(source: String): List<MathSegment> {
        // Codex writes `\[…\]`/`\(…\)`; fold those into the dollar forms
        // this scanner and InlineMath speak before anything else looks
        // at the text. Segments therefore carry the NORMALIZED source —
        // a span that survives into a `Markdown` segment (math in a
        // heading, a table cell) shows as `$…$` rather than the original
        // brackets, which is what Claude's raw math already looks like
        // in those positions.
        val text = MathDelimiters.normalize(source)
        // Fast path: virtually every answer has no math at all.
        if (!text.contains('$')) return listOf(MathSegment.Markdown(text))

        val lines = text.split('\n')
        val segments = mutableListOf<MathSegment>()
        val buffer = mutableListOf<String>()

        fun flush() {
            flushBuffered(buffer, segments)
            buffer.clear()
        }

        var openFence: FenceMarker? = null
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()

            val fence = openFence
            if (fence != null) {
                buffer.add(line)
                // Closing fence: same char, at least as long, nothing after.
                if (isClosingFence(line, fence)) openFence = null
                i += 1
                continue
            }
            val marker = fenceMarker(line)
            if (marker != null) {
                openFence = marker
                buffer.add(line)
                i += 1
                continue
            }

            if (trimmed == DOUBLE_DOLLAR) {
                // Fenced math — only commit once the closer exists.
                var close = -1
                for (k in i + 1 until lines.size) {
                    if (lines[k].trim() == DOUBLE_DOLLAR) {
                        close = k
                        break
                    }
                }
                if (close >= 0) {
                    flush()
                    segments.add(
                        MathSegment.DisplayMath(lines.subList(i + 1, close).joinToString("\n").trim()),
                    )
                    i = close + 1
                    continue
                }
            } else if (trimmed.startsWith(DOUBLE_DOLLAR) && trimmed.endsWith(DOUBLE_DOLLAR) && trimmed.length >= 5) {
                val inner = trimmed.substring(2, trimmed.length - 2).trim()
                // Several `$$a$$ … $$b$$` spans on one line are not ONE
                // display formula — leave them for the inline pass.
                if (inner.isNotEmpty() && !inner.contains(DOUBLE_DOLLAR)) {
                    flush()
                    segments.add(MathSegment.DisplayMath(inner))
                    i += 1
                    continue
                }
            }

            buffer.add(line)
            i += 1
        }
        flush()
        return segments
    }

    private const val DOUBLE_DOLLAR = "\$\$"

    /** A ``` or ~~~ fence opener: its character and run length. */
    private data class FenceMarker(val char: Char, val length: Int)

    /** A recognized list marker and the item content after it. */
    private class ListMarker(val token: String, val content: String)

    /**
     * ``` or ~~~ opener (≤3 leading spaces, run of ≥3) → its
     * (char, run length), else null.
     */
    private fun fenceMarker(line: String): FenceMarker? {
        var indent = 0
        while (indent < line.length && line[indent] == ' ') indent += 1
        if (indent > 3 || indent >= line.length) return null
        val first = line[indent]
        if (first != '`' && first != '~') return null
        var end = indent
        while (end < line.length && line[end] == first) end += 1
        val run = end - indent
        return if (run >= 3) FenceMarker(first, run) else null
    }

    /** Closing fence: same char, at least as long, nothing after. */
    private fun isClosingFence(line: String, opener: FenceMarker): Boolean {
        val marker = fenceMarker(line) ?: return false
        return marker.char == opener.char && marker.length >= opener.length &&
            line.trim().all { it == opener.char }
    }

    /**
     * Can this line belong to a plain paragraph? Excludes headings,
     * quotes, table rows, list items, and indented code lines.
     */
    private fun isPlainParagraphLine(line: String): Boolean {
        var indent = 0
        while (indent < line.length && line[indent] == ' ') indent += 1
        if (indent > 3) return false
        if (indent >= line.length) return false
        val rest = line.substring(indent)
        val first = rest[0]
        if (first == '#' || first == '>' || first == '|') return false
        if (first == '-' || first == '*' || first == '+') {
            // A list marker needs a following space — "*emphasis*"
            // and thematic-break "---" lines stay paragraph-ish.
            return rest.length == 1 || rest[1] != ' '
        }
        if (first.isDigit()) {
            // Ordered-list marker: digits, then "." or ")", then space.
            var digits = 0
            while (digits < rest.length && rest[digits].isDigit()) digits += 1
            if (digits + 1 < rest.length &&
                (rest[digits] == '.' || rest[digits] == ')') &&
                rest[digits + 1] == ' '
            ) {
                return false
            }
        }
        return true
    }

    /** A `-`/`*`/`+` or `N.`/`N)` marker at the start of [s], else null. */
    private fun listMarker(s: String): ListMarker? {
        if (s.isEmpty()) return null
        val first = s[0]
        if (first == '-' || first == '*' || first == '+') {
            if (s.length < 2 || s[1] != ' ') return null
            return ListMarker(first.toString(), s.substring(2))
        }
        if (first.isDigit()) {
            var digits = 0
            while (digits < s.length && s[digits].isDigit()) digits += 1
            if (digits > 9 || digits >= s.length) return null
            val punct = s[digits]
            if (punct != '.' && punct != ')') return null
            if (digits + 1 >= s.length || s[digits + 1] != ' ') return null
            return ListMarker(s.substring(0, digits) + punct, s.substring(digits + 2))
        }
        return null
    }

    /**
     * Parses a block as a FLAT list: every line is either a
     * top-level (indent 0) marker line or a lazy continuation of
     * the previous item. Anything else — indented markers
     * (nesting), a leading non-marker line — returns null and the
     * block stays plain markdown.
     */
    private fun flatListItems(block: List<String>): List<MathListItem>? {
        val items = mutableListOf<MathListItem>()
        for (line in block) {
            var indent = 0
            while (indent < line.length && line[indent] == ' ') indent += 1
            val rest = line.substring(indent)
            val marker = listMarker(rest)
            if (marker != null) {
                if (indent != 0) return null // nested → bail
                items.add(MathListItem(marker = marker.token, text = marker.content))
            } else if (items.isNotEmpty()) {
                val last = items[items.size - 1]
                items[items.size - 1] = MathListItem(marker = last.marker, text = last.text + "\n" + rest)
            } else {
                return null
            }
        }
        return if (items.isEmpty()) null else items
    }

    /**
     * Emit the buffered markdown, carving out plain paragraphs
     * and flat lists that carry inline math. Fences are re-tracked
     * here because the outer loop buffers fence bodies verbatim.
     */
    private fun flushBuffered(buffered: List<String>, segments: MutableList<MathSegment>) {
        val mdRun = mutableListOf<String>()
        fun flushMarkdownRun() {
            // Whitespace-only chunks (blank lines around a math
            // block) would render as stray empty paragraphs — drop
            // them. Blank lines BETWEEN real text stay inside one
            // run, so paragraph breaks are unaffected.
            val joined = mdRun.joinToString("\n")
            mdRun.clear()
            if (joined.isNotBlank()) segments.add(MathSegment.Markdown(joined))
        }
        var fence: FenceMarker? = null
        var i = 0
        while (i < buffered.size) {
            val line = buffered[i]
            val active = fence
            if (active != null) {
                mdRun.add(line)
                if (isClosingFence(line, active)) fence = null
                i += 1
                continue
            }
            val marker = fenceMarker(line)
            if (marker != null) {
                fence = marker
                mdRun.add(line)
                i += 1
                continue
            }
            if (line.isBlank()) {
                mdRun.add(line)
                i += 1
                continue
            }
            // Paragraph block: consecutive non-blank, non-fence lines.
            var j = i
            while (j < buffered.size && !buffered[j].isBlank() && fenceMarker(buffered[j]) == null) {
                j += 1
            }
            val block = buffered.subList(i, j)
            val blockText = block.joinToString("\n")
            if (block.all { isPlainParagraphLine(it) } && InlineMath.containsMath(blockText)) {
                flushMarkdownRun()
                segments.add(MathSegment.InlineParagraph(blockText))
            } else {
                val items = flatListItems(block)
                if (items != null && items.any { InlineMath.containsMath(it.text) }) {
                    flushMarkdownRun()
                    segments.add(MathSegment.InlineList(items))
                } else {
                    mdRun.addAll(block)
                }
            }
            i = j
        }
        flushMarkdownRun()
    }
}
