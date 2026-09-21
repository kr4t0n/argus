package app.argus.core.engine

// Port of ArgusKit `Engine/MathDelimiters.swift`; the original is
// `normalizeMathDelimiters` in `apps/web/src/lib/markdown.ts`. Keep the
// three in step (docs/plan-android-native-client.md §4).
//
// Indexing note: the web scans UTF-16 code units and Swift scans grapheme
// clusters (a `[Character]` array). Kotlin strings are UTF-16 like JS, so
// this port indexes the `String` directly with `Int` offsets — the TS
// semantics. Every character the scanner keys on is ASCII, so no slice
// can land inside a surrogate pair.

/**
 * Folds LaTeX bracket delimiters into the dollar forms the rest of the
 * math pipeline understands: `\[…\]` → `$$…$$` (display) and `\(…\)` →
 * `$…$` (inline).
 *
 * Claude emits dollars; **Codex emits brackets**. A survey of 2232 real
 * Codex answers found 24 display spans (across 11 answers) and 13
 * inline spans (across 6) — rare per-answer, but a hard failure when it
 * lands: [MathSegments] never sees math, so the formula falls through
 * to the markdown parser, which pairs the `_` subscripts inside it as
 * emphasis and eats them. Normalizing here, before any scanning, keeps
 * every downstream stage (display split, inline runs) unchanged.
 *
 * Conservative by construction — a span is rewritten only when:
 * - the closer exists, so a half-streamed `\[` stays raw and snaps into
 *   math once the closer arrives (the same self-correction `$$` has);
 * - the content is non-blank, holds no `$` (which would collide with
 *   the delimiters we emit) and no blank line (which would split the
 *   markdown block);
 * - it sits outside ``` / ~~~ fences and outside backtick code spans —
 *   a shell `find . \( -name "*.h" \)` inside a fence must not mathify.
 *
 * Requiring a *pair* is what protects CommonMark's escaped brackets: a
 * lone `\[` meaning a literal `[` is left alone. All four conditions
 * cost nothing on the surveyed corpus (0 spans carrying `$`, 0 with
 * blank lines, 0 unpaired openers) — insurance, not filters.
 *
 * Web counterpart: `normalizeMathDelimiters` in `apps/web/src/lib/
 * markdown.ts`; iOS counterpart: ArgusKit `Engine/MathDelimiters.swift`.
 * Same rules — keep them in step.
 */
object MathDelimiters {
    fun normalize(text: String): String {
        if (!text.contains("\\[") && !text.contains("\\(")) return text

        // Fences are masked line-wise (a fence body may hold anything);
        // spans may cross lines, so each unfenced run is rewritten as
        // one joined region.
        val lines = text.split('\n')
        val fenced = BooleanArray(lines.size)
        var openFence: FenceMarker? = null
        for ((index, line) in lines.withIndex()) {
            val marker = fenceMarker(line)
            val fence = openFence
            if (fence != null) {
                fenced[index] = true
                if (marker != null && marker.char == fence.char && marker.length >= fence.length &&
                    line.trim().all { it == fence.char }
                ) {
                    openFence = null
                }
            } else if (marker != null) {
                openFence = marker
                fenced[index] = true
            }
        }

        val out = ArrayList<String>(lines.size)
        var i = 0
        while (i < lines.size) {
            if (fenced[i]) {
                out.add(lines[i])
                i += 1
                continue
            }
            var j = i
            while (j < lines.size && !fenced[j]) j += 1
            out.add(rewrite(lines.subList(i, j).joinToString("\n")))
            i = j
        }
        return out.joinToString("\n")
    }

    /** A ``` or ~~~ fence opener: its character and run length. */
    private data class FenceMarker(val char: Char, val length: Int)

    /**
     * ``` or ~~~ opener (≤3 leading spaces, run of ≥3) → its
     * (char, run length), else null. Mirrors [MathSegments]' scanner.
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

    /**
     * Rewrite bracket math in one fence-free region. Indexed by integer
     * offset: the scan jumps by two (escape pairs) and backtracks past
     * code spans, and integer offsets keep that arithmetic obvious.
     */
    private fun rewrite(region: String): String {
        val n = region.length
        val out = StringBuilder(n)
        var i = 0
        while (i < n) {
            val char = region[i]

            if (char == '`') {
                // Code span: copy through to the matching equal-length
                // backtick run, so `` `\(x\)` `` stays code. An
                // unmatched opener is literal text.
                val start = i
                while (i < n && region[i] == '`') i += 1
                val length = i - start
                var j = i
                var closed = false
                while (j < n) {
                    if (region[j] == '`') {
                        val runStart = j
                        while (j < n && region[j] == '`') j += 1
                        if (j - runStart == length) {
                            closed = true
                            break
                        }
                    } else {
                        j += 1
                    }
                }
                out.append(region.substring(start, if (closed) j else i))
                if (closed) i = j
                continue
            }

            if (char == '\\' && i + 1 < n) {
                val next = region[i + 1]
                if (next == '[' || next == '(') {
                    val display = next == '['
                    val end = findCloser(region, i + 2, if (display) ']' else ')')
                    if (end != null) {
                        val content = region.substring(i + 2, end)
                        if (isRewritable(content)) {
                            val delimiter = if (display) "\$\$" else "\$"
                            out.append(delimiter).append(content).append(delimiter)
                            i = end + 2
                            continue
                        }
                    }
                }
                // Any other escape (`\\`, `\_`, an unpaired `\[`) is verbatim.
                out.append(char).append(next)
                i += 2
                continue
            }

            out.append(char)
            i += 1
        }
        return out.toString()
    }

    /**
     * Offset of the backslash in the next `\<closer>`, honoring `\\`
     * escape pairs so `\\]` (literal backslash, then `]`) doesn't close
     * the span. null when the span never closes.
     */
    private fun findCloser(text: String, from: Int, closer: Char): Int? {
        val n = text.length
        var i = from
        while (i < n) {
            if (text[i] == '\\') {
                if (i + 1 < n && text[i + 1] == closer) return i
                i += 2
                continue
            }
            i += 1
        }
        return null
    }

    /** The content guards, shared with the web. */
    private fun isRewritable(content: String): Boolean {
        if (content.isBlank()) return false
        if (content.contains('$')) return false
        // A blank *interior* line would end the markdown block the
        // generated `$$` has to stay inside.
        val lines = content.split('\n')
        if (lines.size <= 2) return true
        return lines.subList(1, lines.size - 1).none { it.isBlank() }
    }
}
