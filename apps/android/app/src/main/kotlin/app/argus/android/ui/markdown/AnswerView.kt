package app.argus.android.ui.markdown

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.argus.core.engine.AnswerSegment
import app.argus.core.engine.AnswerSegments
import app.argus.core.engine.FileReferences
import app.argus.core.engine.MarkdownImageSource
import app.argus.core.engine.MarkwonMath

/**
 * The assistant's final answer — the Android counterpart of
 * apps/ios/Argus/Sources/Views/MarkdownRender.swift's `AnswerView`.
 *
 * Markwon has no seam for native blocks inside one TextView, so the
 * answer is split first (`AnswerSegments.split` in :core — bracket→dollar
 * math normalization, `$$…$$` display blocks, CLOSED mermaid/html fences,
 * standalone image paragraphs) and rendered as a Column of segments:
 *
 * - Markdown → [MarkwonText], after `MarkwonMath.rewriteInline` turns
 *   single-dollar inline math into Markwon's `$$x$$` inline form.
 * - DisplayMath → [MarkwonText] holding a block-LaTeX fence, so JLatexMath
 *   draws it centred at block size.
 * - Fence("mermaid") → [MermaidBlock], Fence("html") → [HtmlBlock]. An
 *   UNCLOSED renderable fence stays in its Markdown segment while
 *   streaming — a code block that snaps into the diagram when the
 *   closing fence arrives, exactly the web's behaviour.
 * - Image → the three-way split of the web's `img` renderer
 *   (`FileReferences.imageSource`): a workspace path fetches over
 *   fs/read ([WorkspaceImage]); a real URL is handed back to Markwon as
 *   the image line; anything else is inert alt text.
 *
 * Matches the web deliberately: the transcript does NOT syntax-highlight
 * code (that's the file viewer's job).
 */
@Composable
fun AnswerView(
    markdown: String,
    isStreaming: Boolean,
    images: MarkdownImageContext,
    onOpenFile: (path: String, line: Int?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val segments = remember(markdown) { AnswerSegments.split(markdown) }
    val currentOnOpenFile = rememberUpdatedState(onOpenFile)
    val onLink: (String) -> Unit = remember(context) {
        { link -> handleAnswerLink(context, link) { path, line -> currentOnOpenFile.value(path, line) } }
    }

    // Block margins mirror the web's .markdown CSS: p/ul/ol/table my-3
    // (12); each Markwon segment carries its own inner block spacing.
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (segment in segments) {
            when (segment) {
                is AnswerSegment.Markdown -> MarkwonText(
                    markdown = remember(segment.text) { MarkwonMath.rewriteInline(segment.text) },
                    modifier = Modifier.fillMaxWidth(),
                    onLink = onLink,
                )
                is AnswerSegment.DisplayMath -> MarkwonText(
                    markdown = "\$\$\n${segment.latex}\n\$\$",
                    modifier = Modifier.fillMaxWidth(),
                )
                is AnswerSegment.Fence -> when (segment.language.lowercase()) {
                    "mermaid" -> MermaidBlock(segment.code, Modifier.fillMaxWidth(), isStreaming)
                    "html" -> HtmlBlock(segment.code, Modifier.fillMaxWidth(), isStreaming)
                    // Defensive: only renderableFences reach here today.
                    else -> MarkwonText(
                        markdown = fenceMarkdown(segment.language, segment.code),
                        modifier = Modifier.fillMaxWidth(),
                        onLink = onLink,
                    )
                }
                is AnswerSegment.Image -> AnswerImage(segment, images, onLink)
            }
        }
    }
}

@Composable
private fun AnswerImage(
    segment: AnswerSegment.Image,
    images: MarkdownImageContext,
    onLink: (String) -> Unit,
) {
    when (val source = FileReferences.imageSource(segment.source, images.workingDir)) {
        is MarkdownImageSource.Workspace -> if (images.projectId != null) {
            WorkspaceImage(source.relative, segment.alt, images, Modifier.fillMaxWidth())
        } else {
            // No project to fetch from: the path renders inert, like iOS.
            InertImageLabel(text = segment.alt.ifBlank { source.relative }, modifier = Modifier.fillMaxWidth())
        }
        // A real http(s) URL is Markwon's business — handed back as the
        // image line it came from.
        is MarkdownImageSource.Remote -> MarkwonText(
            markdown = "![${segment.alt}](${segment.source})",
            modifier = Modifier.fillMaxWidth(),
            onLink = onLink,
        )
        // Outside the workspace (`/tmp/shot.png`), a non-http scheme,
        // empty, directory-shaped: the sidecar's jail wouldn't serve it,
        // and widening that jail is a security decision, not a bug.
        MarkdownImageSource.Inert -> InertImageLabel(
            text = segment.alt.ifBlank { segment.source },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/** Re-emit a fence for Markwon, with a fence long enough to contain the code's own backticks. */
private fun fenceMarkdown(language: String, code: String): String {
    val body = code.trimEnd('\n')
    var longest = 0
    var run = 0
    for (ch in body) {
        run = if (ch == '`') run + 1 else 0
        if (run > longest) longest = run
    }
    val fence = "`".repeat(maxOf(3, longest + 1))
    return "$fence$language\n$body\n$fence"
}

/** The same `^[a-z][a-z0-9+.-]*:` scheme test `FileReferences` uses. */
private val uriSchemePattern = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

/**
 * The web's two-layer gotcha, in LinkResolver form — a port of iOS
 * `handleAnswerLink` (SessionView.swift): (1) a real scheme
 * (http/https/mailto) goes to the system — this keeps
 * `http://localhost:3000` a browser link; (2) anything else is tried as
 * a `path[:line[:col]]` citation — note `xxx.txt:1` parses as URL scheme
 * "xxx.txt", which is exactly why the check can't just be "has a scheme".
 * File-ish only (contains . or /) — bare words stay inert rather than
 * opening a garbage preview.
 */
internal fun handleAnswerLink(context: Context, raw: String, onOpenFile: (String, Int?) -> Unit) {
    val scheme = uriSchemePattern.find(raw)?.value?.dropLast(1)?.lowercase()
    if (scheme == "http" || scheme == "https" || scheme == "mailto") {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw)))
        } catch (_: ActivityNotFoundException) {
            // Nothing installed to take it; the link stays a no-op.
        }
        return
    }
    val decoded = if (raw.contains('%')) Uri.decode(raw) else raw
    val split = FileReferences.splitLineSuffix(decoded)
    if (!split.path.contains('/') && !split.path.contains('.')) return
    onOpenFile(split.path, split.line)
}
