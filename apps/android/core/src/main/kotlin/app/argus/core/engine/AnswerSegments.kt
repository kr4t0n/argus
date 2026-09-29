package app.argus.core.engine

// The answer-rendering pipeline's block splitter. The Android renderer
// draws an answer as a column of segments — markdown through the
// TextView-based markdown engine, display math through its LaTeX block,
// ```mermaid and ```html fences through WebView hosts, and standalone
// workspace images through the fs-read image view — the same seams the
// iOS AnswerView interleaves (MathSegments + MathBlock + MermaidBlock +
// MarkdownImage). MathSegments does the math split (bracket→dollar
// normalization included, code fences immune); this layers the fence and
// image extraction on top of its markdown pieces.
//
// Streaming rule, shared with the web's MarkdownCodeBlock: an UNCLOSED
// renderable fence stays inside the markdown, so it renders as an
// ordinary code block token by token and snaps into a diagram when its
// closer arrives. Non-renderable fences are never extracted — the
// markdown engine renders them as code blocks itself.

sealed interface AnswerSegment {
    /** Ordinary markdown (may contain non-renderable code fences and inline math). */
    data class Markdown(val text: String) : AnswerSegment

    /** A `$$…$$` display-math block, LaTeX source without delimiters. */
    data class DisplayMath(val latex: String) : AnswerSegment

    /** A CLOSED fence in [AnswerSegments.renderableFences]; [language] is lowercased. */
    data class Fence(val language: String, val code: String) : AnswerSegment

    /** A paragraph that is exactly one `![alt](source)` image. */
    data class Image(val source: String, val alt: String) : AnswerSegment
}

object AnswerSegments {
    /** Fence languages that get a rendered view with a Source toggle. */
    val renderableFences: Set<String> = setOf("mermaid", "html")

    fun split(markdown: String): List<AnswerSegment> {
        val out = ArrayList<AnswerSegment>()
        for (segment in MathSegments.split(markdown)) {
            when (segment) {
                is MathSegment.DisplayMath -> out += AnswerSegment.DisplayMath(segment.latex)
                is MathSegment.Markdown -> extractBlocks(segment.text, out)
                is MathSegment.InlineParagraph -> extractBlocks(segment.text, out)
                // The list is re-emitted as markdown (the marker is the
                // literal source marker), so the markdown engine renders
                // it and the inline-math rewrite still applies.
                is MathSegment.InlineList ->
                    appendMarkdown(out, segment.items.joinToString("\n") { "${it.marker} ${it.text}" })
            }
        }
        return out
    }

    private val imageParagraph =
        Regex("""^ {0,3}!\[([^\]]*)]\(\s*<?([^\s>)]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*$""")

    private fun extractBlocks(text: String, out: MutableList<AnswerSegment>) {
        val lines = text.split('\n')
        val plain = StringBuilder()
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val fence = MarkdownFences.opener(line)
            if (fence != null) {
                var closer = -1
                var j = i + 1
                while (j < lines.size) {
                    if (MarkdownFences.isCloser(lines[j], fence.marker)) {
                        closer = j
                        break
                    }
                    j++
                }
                if (closer >= 0 && fence.language in renderableFences) {
                    flush(plain, out)
                    out += AnswerSegment.Fence(fence.language, lines.subList(i + 1, closer).joinToString("\n"))
                    i = closer + 1
                    continue
                }
                // Not renderable, or unclosed (still streaming): keep the
                // fence verbatim through its closer, or to the end.
                val end = if (closer >= 0) closer else lines.size - 1
                for (k in i..end) plain.append(lines[k]).append('\n')
                i = end + 1
                continue
            }

            val image = imageParagraph.matchEntire(line)
            if (image != null && standsAlone(lines, i)) {
                flush(plain, out)
                out += AnswerSegment.Image(source = image.groupValues[2], alt = image.groupValues[1])
                i++
                continue
            }

            plain.append(line).append('\n')
            i++
        }
        flush(plain, out)
    }

    /** The line is its own paragraph: blank (or nothing) on both sides. */
    private fun standsAlone(lines: List<String>, index: Int): Boolean {
        val before = index == 0 || lines[index - 1].isBlank()
        val after = index == lines.size - 1 || lines[index + 1].isBlank()
        return before && after
    }

    private fun flush(plain: StringBuilder, out: MutableList<AnswerSegment>) {
        if (plain.isEmpty()) return
        // Blank lines around an extracted block are structure, not content.
        val text = plain.toString().trim('\n')
        plain.setLength(0)
        if (text.isBlank()) return
        appendMarkdown(out, text)
    }

    /** Adjacent markdown pieces merge, so the engine sees one document, not paragraph shards. */
    private fun appendMarkdown(out: MutableList<AnswerSegment>, text: String) {
        val last = out.lastOrNull()
        if (last is AnswerSegment.Markdown) {
            out[out.size - 1] = AnswerSegment.Markdown(last.text + "\n\n" + text)
        } else {
            out += AnswerSegment.Markdown(text)
        }
    }
}

/**
 * Rewrites inline math for the markdown engine, whose LaTeX extension
 * recognizes `$$…$$` on one line as INLINE math (and `$$` on its own
 * lines as a block). Claude writes single-dollar `$x$`; the web's
 * remark-math and the iOS InlineMath scanner both accept it, so this is
 * where Android folds it into the engine's form. Fenced code is left
 * untouched, `\$` escapes and backtick spans are honoured by
 * [InlineMath.runs], and a line that opens with `$$` (an unclosed
 * display block while streaming) is passed through as-is.
 */
object MarkwonMath {
    fun rewriteInline(markdown: String): String {
        if (!markdown.contains('$')) return markdown
        val out = StringBuilder(markdown.length + 16)
        var openFence: String? = null
        val lines = markdown.split('\n')
        for ((index, line) in lines.withIndex()) {
            if (index > 0) out.append('\n')
            val opener = if (openFence == null) MarkdownFences.opener(line) else null
            if (opener != null) {
                openFence = opener.marker
                out.append(line)
                continue
            }
            val fence = openFence
            if (fence != null) {
                if (MarkdownFences.isCloser(line, fence)) openFence = null
                out.append(line)
                continue
            }
            if (!line.contains('$') || line.trimStart().startsWith("$$")) {
                out.append(line)
                continue
            }
            for (run in InlineMath.runs(line)) {
                when (run) {
                    is InlineMathRun.Text -> out.append(run.text)
                    is InlineMathRun.Math -> out.append("$$").append(run.latex).append("$$")
                }
            }
        }
        return out.toString()
    }
}

/** CommonMark fence recognition shared by the splitter and the rewrite. */
internal object MarkdownFences {
    data class Opener(val marker: String, val language: String)

    private val openerPattern = Regex("""^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*).*$""")

    fun opener(line: String): Opener? {
        val match = openerPattern.matchEntire(line) ?: return null
        return Opener(marker = match.groupValues[1], language = match.groupValues[2].lowercase())
    }

    /** Same fence character, at least the opener's length, nothing else on the line. */
    fun isCloser(line: String, marker: String): Boolean {
        val trimmed = line.trimStart(' ')
        if (line.length - trimmed.length > 3) return false
        val run = trimmed.takeWhile { it == marker[0] }
        return run.length >= marker.length && trimmed.substring(run.length).isBlank()
    }
}
