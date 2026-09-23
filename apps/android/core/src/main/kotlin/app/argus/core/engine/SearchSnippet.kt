package app.argus.core.engine

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/SearchSnippet.swift,
// itself a port of `renderSnippet` in apps/web/src/components/CommandPalette.tsx
// over the `SEARCH_HL_START` / `SEARCH_HL_STOP` sentinels declared in
// packages/shared-types/src/api.ts.

/**
 * Splits a `GET /search/sessions` snippet into plain and highlighted
 * runs — the port of `renderSnippet` in the web's `CommandPalette.tsx`.
 *
 * The server wraps matched terms in `[[hl]]` / `[[/hl]]` sentinels
 * rather than HTML (`SEARCH_HL_START` / `SEARCH_HL_STOP` in
 * shared-types, duplicated in the server's SearchService): transcript
 * text is model- and user-authored and must never reach an HTML sink,
 * so every client splits on the sentinels and builds native text runs.
 * Change the constants everywhere or nowhere — shared-types, the
 * server's SearchService, ArgusKit's `SearchSnippet.swift`, and here.
 *
 * Unpaired markers are left as literal text rather than swallowing the
 * rest of the snippet. Whitespace is collapsed so a row stays two lines
 * tall regardless of how the doc was laid out.
 */
object SearchSnippet {
    const val highlightStart = "[[hl]]"
    const val highlightStop = "[[/hl]]"

    data class Run(
        val text: String,
        val highlighted: Boolean,
    )

    fun runs(snippet: String): List<Run> {
        val flat = collapseWhitespace(snippet)
        val out = ArrayList<Run>()
        var rest = flat
        while (true) {
            val start = rest.indexOf(highlightStart)
            if (start < 0) break
            val stop = rest.indexOf(highlightStop, start + highlightStart.length)
            if (stop < 0) break
            if (start > 0) {
                out.add(Run(text = rest.substring(0, start), highlighted = false))
            }
            val marked = rest.substring(start + highlightStart.length, stop)
            if (marked.isNotEmpty()) {
                out.add(Run(text = marked, highlighted = true))
            }
            rest = rest.substring(stop + highlightStop.length)
        }
        if (rest.isNotEmpty()) {
            out.add(Run(text = rest, highlighted = false))
        }
        return out
    }

    /**
     * The TS `snippet.replace(/\s+/g, ' ').trim()` (and Swift's
     * split-on-whitespace-then-join): every run of whitespace becomes one
     * space, and leading/trailing whitespace is dropped. Hand-rolled
     * rather than a `Regex("\\s+")` because the JVM's `\s` is ASCII-only
     * unless the UNICODE_CHARACTER_CLASS flag is set, whereas JavaScript's
     * `\s` (and Swift's `Character.isWhitespace`) is Unicode whitespace —
     * which is what [Char.isWhitespace] answers.
     */
    private fun collapseWhitespace(text: String): String {
        val out = StringBuilder(text.length)
        var pendingSpace = false
        for (ch in text) {
            if (ch.isWhitespace()) {
                // Leading whitespace never earns a space (out is still empty).
                pendingSpace = out.isNotEmpty()
            } else {
                if (pendingSpace) {
                    out.append(' ')
                    pendingSpace = false
                }
                out.append(ch)
            }
        }
        return out.toString()
    }
}
