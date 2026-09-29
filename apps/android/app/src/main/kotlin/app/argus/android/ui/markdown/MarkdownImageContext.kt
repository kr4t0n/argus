package app.argus.android.ui.markdown

import app.argus.core.model.FSReadResult

/**
 * What an answer's `![alt](path)` images need to resolve a path INSIDE
 * the agent's working directory to real bytes: the project route for
 * `GET /projects/:id/fs/read`, the working dir for the relative split,
 * and the turn's settle time as the cache epoch — an agent that
 * regenerates `preview.png` next turn emits the same path, and a
 * path-only cache key would show the previous turn's bytes.
 *
 * Mirrors `MarkdownImageContext` in apps/ios/Argus/Sources/Views/MarkdownImage.swift.
 * The three-way split (real URL / workspace path / inert alt text) is
 * `FileReferences.imageSource` in :core; the out-of-workspace case is
 * NOT an oversight — the sidecar's fs jail refuses absolute paths and
 * `..` escapes by design.
 */
class MarkdownImageContext(
    val projectId: String?,
    val workingDir: String?,
    /** The turn's `completedAt` (null while running) — the cache epoch. */
    val turnEpoch: String?,
    /** `GET /projects/:id/fs/read`; null when the app has no client. */
    val readFile: suspend (projectId: String, path: String) -> FSReadResult?,
) {
    companion object {
        /** No project to read from: every workspace path renders inert. */
        val None = MarkdownImageContext(null, null, null) { _, _ -> null }
    }
}
