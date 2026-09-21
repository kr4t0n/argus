package app.argus.core.engine

// Unified-diff line classification for the diff renderer — the pure part
// of apps/web/src/components/ui/DiffBlock.tsx. The sidecar emits unified
// diffs for every file-editing tool (meta.isDiff); the client only
// colours lines, it never re-diffs.

enum class DiffLineKind {
    /** `+` line (not the `+++` file header). */
    ADD,
    /** `-` line (not the `---` file header). */
    REMOVE,
    /** `@@ … @@` hunk header. */
    HUNK,
    /** `diff --git`, `index`, `---`/`+++` file headers, `\ No newline…`. */
    META,
    CONTEXT,
}

data class DiffLine(val kind: DiffLineKind, val text: String)

/** Added and removed line counts — the `+N −M` badge. */
data class DiffCounts(val added: Int, val removed: Int)

object DiffLines {
    fun classify(line: String): DiffLineKind = when {
        line.startsWith("@@") -> DiffLineKind.HUNK
        line.startsWith("+++") || line.startsWith("---") -> DiffLineKind.META
        line.startsWith("diff ") || line.startsWith("index ") ||
            line.startsWith("\\ No newline") ||
            line.startsWith("new file mode") || line.startsWith("deleted file mode") ||
            line.startsWith("rename from") || line.startsWith("rename to") ||
            line.startsWith("similarity index") -> DiffLineKind.META
        line.startsWith("+") -> DiffLineKind.ADD
        line.startsWith("-") -> DiffLineKind.REMOVE
        else -> DiffLineKind.CONTEXT
    }

    /** One entry per line, in order. A trailing newline does not add an empty line. */
    fun parse(diff: String): List<DiffLine> {
        if (diff.isEmpty()) return emptyList()
        val lines = diff.split('\n')
        val end = if (lines.last().isEmpty()) lines.size - 1 else lines.size
        return List(end) { i -> DiffLine(classify(lines[i]), lines[i]) }
    }

    fun counts(diff: String): DiffCounts {
        var added = 0
        var removed = 0
        for (line in parse(diff)) {
            when (line.kind) {
                DiffLineKind.ADD -> added++
                DiffLineKind.REMOVE -> removed++
                else -> {}
            }
        }
        return DiffCounts(added, removed)
    }
}
