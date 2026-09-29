package app.argus.core.engine

// Port of ArgusKit `Engine/InlineMath.swift`. The delimiter semantics
// are those of the web's remark-math (micromark math-text) — see the
// rules on [InlineMath] — so the web is the semantic original and the
// Swift file the primary source.
//
// Indexing note: Swift walks `String.Index` over grapheme clusters; this
// port walks `Int` offsets over UTF-16 code units, as JS/micromark do.
// Every character the scanner keys on (`$`, `` ` ``, `\`) is ASCII, so
// no run boundary can fall inside a surrogate pair and the two agree on
// every span.

/** One run of an inline-math-bearing paragraph. */
sealed interface InlineMathRun {
    /** Ordinary inline markdown (may contain bold/italic/code/links). */
    data class Text(val text: String) : InlineMathRun

    /** The inside of a `$…$` (or mid-paragraph `$$…$$`) span. */
    data class Math(val latex: String) : InlineMathRun
}

/**
 * Splits one paragraph into text and inline-math runs.
 *
 * Delimiter semantics mirror the web's remark-math (micromark
 * math-text), which pairs like code spans — any `$` with a matching
 * closer mathifies, including the accepted "$5 and then $10"
 * false positive. Specifically:
 * - `$…$` and mid-paragraph `$$…$$` open a span; the closer must be a
 *   dollar run of the SAME length.
 * - Backtick code spans are immune (`` `$PATH` `` stays code), matched
 *   by equal-length backtick runs per CommonMark.
 * - `\$` is an escaped literal dollar, never a delimiter.
 * - Empty or whitespace-only spans don't count.
 */
object InlineMath {
    fun runs(paragraph: String): List<InlineMathRun> {
        if (!paragraph.contains('$')) return listOf(InlineMathRun.Text(paragraph))
        val n = paragraph.length
        val runs = mutableListOf<InlineMathRun>()
        var textStart = 0
        var i = 0

        /** Offset just past the run of [char] starting at [start]. */
        fun charRun(char: Char, start: Int): Int {
            var end = start
            while (end < n && paragraph[end] == char) end += 1
            return end
        }

        while (i < n) {
            val char = paragraph[i]
            if (char == '\\') {
                // Escape: skip the backslash and whatever follows.
                i = minOf(i + 2, n)
                continue
            }
            if (char == '`') {
                // Code span: skip to the matching equal-length backtick
                // run; an unmatched opener is literal text.
                val openEnd = charRun('`', i)
                val length = openEnd - i
                var j = openEnd
                var closed = false
                while (j < n) {
                    if (paragraph[j] == '`') {
                        val end = charRun('`', j)
                        if (end - j == length) {
                            i = end
                            closed = true
                            break
                        }
                        j = end
                    } else {
                        j += 1
                    }
                }
                if (!closed) i = openEnd
                continue
            }
            if (char == '$') {
                val openEnd = charRun('$', i)
                val length = minOf(openEnd - i, 2)
                val contentStart = i + length
                var j = contentStart
                // The matched span, as (contentEnd, end): contentEnd is
                // where the closing run starts, end is just past it.
                var contentEnd = -1
                var spanEnd = -1
                while (j < n) {
                    val c = paragraph[j]
                    if (c == '\\') {
                        j = minOf(j + 2, n)
                        continue
                    }
                    if (c == '$') {
                        val end = charRun('$', j)
                        if (end - j == length) {
                            contentEnd = j
                            spanEnd = end
                            break
                        }
                        // Mismatched run: keep scanning, like micromark —
                        // `$a$$b$` closes at the LAST dollar (content a$$b).
                        j = end
                        continue
                    }
                    j += 1
                }
                if (spanEnd >= 0 && !paragraph.substring(contentStart, contentEnd).isBlank()) {
                    if (textStart < i) {
                        runs.add(InlineMathRun.Text(paragraph.substring(textStart, i)))
                    }
                    runs.add(InlineMathRun.Math(paragraph.substring(contentStart, contentEnd)))
                    i = spanEnd
                    textStart = i
                } else {
                    i = openEnd
                }
                continue
            }
            i += 1
        }
        if (textStart < n) {
            runs.add(InlineMathRun.Text(paragraph.substring(textStart)))
        }
        return if (runs.isEmpty()) listOf(InlineMathRun.Text(paragraph)) else runs
    }

    /** Whether the paragraph has at least one inline-math span. */
    fun containsMath(paragraph: String): Boolean = runs(paragraph).any { it is InlineMathRun.Math }
}
