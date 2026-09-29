package app.argus.core.engine

import app.argus.core.model.ResultChunk
import app.argus.core.model.ResultKind
import app.argus.core.model.asArray
import app.argus.core.model.asObject
import app.argus.core.model.asString
import java.net.URI
import java.net.URISyntaxException

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/FileReferences.swift,
// itself a port of the web's apps/web/src/components/FileChips.tsx helpers
// (`extractFiles`, `displayPath`, `splitLineSuffix`, `toAgentRelative`) and
// the three-way `img` source split in
// apps/web/src/components/StreamViewer.tsx / MarkdownImage.tsx.
//
// Kotlin strings are UTF-16 like JavaScript, so the string arithmetic here
// follows the TypeScript original directly (`dir.length + 1`), not Swift's
// grapheme counts.

/**
 * File-path plumbing for the transcript's file-preview flow — a pure
 * port of the web's `FileChips.tsx` helpers (`extractFiles`,
 * `displayPath`, `splitLineSuffix`, `toAgentRelative`). Keep the
 * semantics identical: which chips appear, how paths abbreviate, and
 * which `path:line` citations count must match across clients.
 */
object FileReferences {
    /**
     * Tools whose path argument is a directory or a command line — not
     * an openable file preview.
     */
    private val skippedTools: Set<String> = setOf(
        "bash", "shell", "ls", "list_dir", "glob", "grep",
    )

    /** Input keys probed for a single file path, in priority order. */
    private val singleFileKeys = listOf("file_path", "filePath", "path", "filename", "file")

    /** Input keys probed for an array of file paths. */
    private val fileListKeys = listOf("files", "paths")

    /**
     * Lazy match so `src/foo.go:123:45` splits at the FIRST numeric
     * suffix (line 123, col 45).
     */
    private val lineSuffixPattern = Regex("^(.+?):([0-9]+)(?::[0-9]+)?\$")

    /**
     * The same `^[a-z][a-z0-9+.-]*:` scheme test the web's `img` renderer
     * uses (case-insensitive there; the class is widened here instead).
     */
    private val uriSchemePattern = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

    /**
     * Pull file paths out of tool inputs (`file_path`, `path`,
     * `filename`, `files[]`, …), deduped in first-seen order — the
     * artefacts the agent actually touched.
     */
    fun extractFiles(chunks: List<ResultChunk>): List<String> {
        val seen = HashSet<String>()
        val out = ArrayList<String>()
        for (chunk in chunks) {
            if (chunk.kind != ResultKind.TOOL) continue
            val meta = chunk.meta
            val tool = (meta?.get("tool")?.asString ?: "").lowercase()
            if (tool in skippedTools) continue
            val input = meta?.get("input")?.asObject

            val candidates = ArrayList<String>()
            for (key in singleFileKeys) {
                input?.get(key)?.asString?.let { candidates.add(it) }
            }
            for (key in fileListKeys) {
                val values = input?.get(key)?.asArray ?: continue
                for (value in values) {
                    value.asString?.let { candidates.add(it) }
                }
            }

            for (path in candidates) {
                if (path.isEmpty() || !seen.add(path)) continue
                out.add(path)
            }
        }
        return out
    }

    /**
     * Strip the agent's workingDir prefix off an absolute path so chips
     * show the part that changes. Falls back to the absolute form when
     * there's no workingDir, the path is already relative, or it lives
     * OUTSIDE the workspace (then the absolute path IS the signal).
     * The `dir + "/"` boundary check stops `/work/proj` from matching
     * `/work/projx/file.ts`.
     */
    fun displayPath(absolute: String, workingDir: String?): String {
        if (workingDir.isNullOrEmpty()) return absolute
        if (!absolute.startsWith("/")) return absolute
        val dir = if (workingDir.endsWith("/")) workingDir.dropLast(1) else workingDir
        if (absolute == dir) return "."
        if (absolute.startsWith("$dir/")) return absolute.substring(dir.length + 1)
        return absolute
    }

    /** Outcome of [splitLineSuffix]: the bare path plus the cited line, if any. */
    data class LineSuffix(val path: String, val line: Int?)

    /**
     * Split a `path:line` / `path:line:col` citation (the form CLI
     * agents use, e.g. `src/foo.go:123`) into path + line. The path
     * part must contain `.` or `/` to count — that keeps URI schemes
     * (`tel:123`) and bare words out; `Makefile:12` is the accepted
     * miss (indistinguishable from a scheme). Columns parse but drop —
     * the viewer scrolls to lines.
     */
    fun splitLineSuffix(path: String): LineSuffix {
        val match = lineSuffixPattern.find(path) ?: return LineSuffix(path, null)
        val bare = match.groupValues[1]
        if (!bare.contains('.') && !bare.contains('/')) return LineSuffix(path, null)
        return LineSuffix(bare, match.groupValues[2].toIntOrNull())
    }

    /**
     * Convert a chip path to the form `fs/read` accepts — relative to
     * the agent's workingDir, and not a directory. null = unopenable
     * (outside the workspace, or directory-shaped).
     */
    fun toAgentRelative(path: String, workingDir: String?): String? {
        val relative: String
        if (path.startsWith("/")) {
            relative = displayPath(path, workingDir)
            if (relative == path) return null
        } else {
            relative = path
        }
        if (relative.isEmpty() || relative == "." || relative.endsWith("/")) return null
        return relative
    }

    /**
     * Where a `![alt](source)` image in an answer should come from —
     * the three-way split of the web's custom `img` renderer
     * (`StreamViewer.tsx`). A real http(s) URL is the browser's/system's
     * business; a path that resolves inside the workspace is fetched
     * over fs/read; everything else renders as inert text, because the
     * sidecar's jail wouldn't serve it anyway (`/tmp/shot.png` is the
     * canonical case — see the AGENTS.md gotcha before widening this).
     *
     * The scheme test is the same `^[a-z][a-z0-9+.-]*:` the web uses,
     * so `xxx.png:1`-shaped strings classify identically on both
     * clients (as a scheme, hence inert — not a workspace path).
     */
    fun imageSource(source: String, workingDir: String?): MarkdownImageSource {
        if (uriSchemePattern.containsMatchIn(source)) {
            val url = try {
                URI(source)
            } catch (_: URISyntaxException) {
                return MarkdownImageSource.Inert
            }
            val scheme = url.scheme?.lowercase() ?: return MarkdownImageSource.Inert
            if (scheme != "http" && scheme != "https") return MarkdownImageSource.Inert
            return MarkdownImageSource.Remote(url)
        }
        val relative = toAgentRelative(source, workingDir) ?: return MarkdownImageSource.Inert
        return MarkdownImageSource.Workspace(relative)
    }
}

/** Outcome of [FileReferences.imageSource]. */
sealed interface MarkdownImageSource {
    /** An http(s) URL — load it directly. */
    data class Remote(val url: URI) : MarkdownImageSource

    /** Inside the agent's workingDir; the payload is the fs/read path. */
    data class Workspace(val relative: String) : MarkdownImageSource

    /**
     * Unfetchable (outside the workspace, non-http scheme, empty,
     * directory-shaped) — render the reference as text.
     */
    data object Inert : MarkdownImageSource
}
