@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.files

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.BitmapFactory
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.argus.android.AppModel
import app.argus.android.ui.markdown.MarkwonText
import app.argus.android.ui.markdown.handleAnswerLink
import app.argus.android.ui.markdown.prepareHtmlDocument
import app.argus.android.ui.session.captionStyle
import app.argus.android.ui.session.monoStyle
import app.argus.android.ui.session.secondaryTextColor
import app.argus.android.ui.session.tertiaryTextColor
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.engine.MarkwonMath
import app.argus.core.engine.ProjectRef
import app.argus.core.model.FSReadResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

// The shared file viewer — the Android counterpart of
// apps/ios/Argus/Sources/Views/FilePreview.swift (FilePreviewSheet,
// TextFileView, StaticHtmlView) and of the web's FileViewer tab. Opened by
// the inspector's Files tree, by the per-turn FileChips, and by `path:line`
// citations in answers; every caller resolves the path to the
// workspace-relative form fs/read accepts before handing it here.

/**
 * What to preview: a workspace-relative path (the form fs/read accepts),
 * a display title, and an optional 1-based line to scroll to + highlight
 * (from a `path:line` citation).
 */
data class FilePreviewTarget(
    val path: String,
    val displayPath: String,
    val line: Int? = null,
)

/**
 * Trailing window for coalescing `fs:changed` nudges, on top of the
 * sidecar's own 250 ms fsWatcher debounce — so a long edit loop settles
 * into one re-read instead of tracking the agent's write rate. Matches
 * the web client's INVALIDATE_DEBOUNCE_MS and the iOS refreshDebounce.
 */
private const val REFRESH_WINDOW_MS = 400L

/**
 * Sub-sampling ceiling for a previewed image. Larger than the inline
 * answer image's (2048) because this viewer is full screen and zoomable;
 * fs/read caps the file at 1 MiB so the decoded bitmap stays bounded.
 */
private const val MAX_DECODED_EDGE = 4096

/**
 * Full-screen file preview. Text renders as monospace lines with a
 * line-number gutter and the target line highlighted; `.md` files render
 * through Markwon and `.html` files in a strictly script-less WebView,
 * both with a Source toggle; images pinch-zoom; binary / unsupported
 * files show a size line. Presented as a full-screen [Dialog] so back
 * (and a hardware keyboard's Escape, which Android's Dialog maps to
 * back) both land in [onDismiss] — the web closes the file tab on esc.
 *
 * Stale-while-revalidate: the sheet joins the project room ITSELF and
 * re-reads the file when an `fs:changed` batch names its directory. The
 * inspector holds the room too when the preview was opened from the
 * Files tree — but a preview opened from a chat citation or a FileChip
 * can have the inspector closed, in which case nothing else is
 * subscribed and no nudge would ever arrive. `StreamClient` refcounts,
 * so the overlapping case is safe.
 */
@Composable
fun FilePreviewSheet(app: AppModel, project: ProjectRef, target: FilePreviewTarget, onDismiss: () -> Unit) {
    val fileName = remember(target.path) { target.path.substringAfterLast('/') }
    // Extension off the BASENAME: `dir.v1/README` has none, and a naive
    // substringAfterLast('.') over the whole path would say "v1/README".
    val extension = remember(fileName) {
        if ('.' in fileName) fileName.substringAfterLast('.').lowercase(Locale.ROOT) else ""
    }
    val isHtml = extension == "html" || extension == "htm"
    val isMarkdown = extension == "md" || extension == "markdown"
    // Directory the previewed file sits in, workingDir-relative. "" for
    // a root-level file — matching how the sidecar names the watched
    // root in its fs-changed nudges, NOT the "." a path API would give.
    val targetDirectory = remember(target.path) { target.path.substringBeforeLast('/', "") }

    var result by remember(project.projectId, target.path) { mutableStateOf<FSReadResult?>(null) }
    var loadError by remember(project.projectId, target.path) { mutableStateOf<String?>(null) }
    var showSource by remember(target.path) { mutableStateOf(false) }

    /**
     * Read the file into `result`. A refresh deliberately does NOT clear
     * `result` first: the reader is looking at this file, and dropping to
     * a spinner every time an agent touches its directory would be worse
     * than the staleness being fixed. A refresh that fails likewise keeps
     * the last good render — an atomic write-then-rename leaves a window
     * where the path briefly doesn't resolve, and that must not blow away
     * a readable file. A cold load still surfaces its error; there is
     * nothing else to show then.
     */
    suspend fun load(isRefresh: Boolean) {
        val client = app.client
        if (client == null) {
            if (!isRefresh) loadError = "Not connected"
            return
        }
        try {
            val fresh = client.readProjectFile(project.projectId, target.path).result
            result = fresh
            loadError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (isRefresh) return
            app.handleApiError(e)
            loadError = (e as? ApiError)?.message ?: e.message ?: "Couldn't read file"
        }
    }

    // Hold the project room for as long as the sheet is up (see the KDoc
    // above for why the sheet holds it itself).
    DisposableEffect(project.machineId, project.workingDir) {
        app.stream?.joinProject(project.machineId, project.workingDir)
        onDispose { app.stream?.leaveProject(project.machineId, project.workingDir) }
    }

    LaunchedEffect(project.projectId, target.path) { load(isRefresh = false) }

    // Live refresh. `drop(1)` skips the batch already sitting in the
    // StateFlow when the sheet opens — that one predates us. Each new
    // batch is a distinct value (AppModel sequence-numbers them), so
    // repeat writes to one directory are never swallowed.
    LaunchedEffect(project, target.path) {
        var window: Job? = null
        app.fsChanges.drop(1).collect { batch ->
            // `fs:changed` is directory-granular (the sidecar drops the
            // filename), so a sibling write re-reads too — accepted,
            // since only one preview is ever open.
            if (targetDirectory !in batch.pathsFor(project.machineId, project.workingDir)) return@collect
            // Do NOT restart an open window. A trailing debounce that
            // resets on every nudge never fires while an agent is
            // actively editing: the sidecar emits roughly every 250 ms
            // and this window is 400 ms, so each nudge would cancel the
            // pending read and the refresh would only land once editing
            // STOPPED — which reads as "auto-refresh doesn't work". The
            // web's schedule() early-returns for exactly this reason,
            // and the iOS port's first cut (cancel-and-re-arm) had
            // precisely that symptom.
            if (window != null) return@collect
            window = launch {
                delay(REFRESH_WINDOW_MS)
                // Cleared BEFORE the read so a nudge arriving during it
                // can open the next window rather than being swallowed.
                window = null
                load(isRefresh = true)
            }
        }
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        // Head-truncated: the file name at the tail is
                        // the part worth keeping.
                        Text(
                            text = target.displayPath,
                            style = MaterialTheme.typography.titleSmall,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            softWrap = false,
                            overflow = TextOverflow.StartEllipsis,
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.Default.Close, contentDescription = "Close")
                        }
                    },
                    actions = {
                        val text = (result as? FSReadResult.Text)?.content
                        if (text != null) {
                            if (isHtml || isMarkdown) {
                                // Text-only actions, like the answer
                                // blocks' chrome: the core icon set has
                                // no code/eye glyphs.
                                TextButton(onClick = { showSource = !showSource }) {
                                    Text(
                                        if (showSource) "Rendered" else "Source",
                                        style = MaterialTheme.typography.labelSmall,
                                    )
                                }
                            }
                            CopyTextAction(text)
                        }
                    },
                )
            },
        ) { innerPadding ->
            Box(Modifier.fillMaxSize().padding(innerPadding)) {
                when (val current = result) {
                    null -> {
                        val error = loadError
                        if (error != null) {
                            CenteredUnavailable("Couldn't read file", error)
                        } else {
                            CenteredProgress()
                        }
                    }
                    is FSReadResult.Text -> when {
                        isHtml && !showSource -> StaticHtmlView(current.content, Modifier.fillMaxSize())
                        isMarkdown && !showSource -> MarkdownFileView(current.content, Modifier.fillMaxSize())
                        else -> TextFileView(current.content, target.line, Modifier.fillMaxSize())
                    }
                    is FSReadResult.Image -> Base64ImagePreview(current.base64, contentDescription = fileName)
                    is FSReadResult.Binary -> CenteredUnavailable("Binary file", formatBytes(current.size))
                    is FSReadResult.Unsupported -> CenteredUnavailable("Unsupported viewer (${current.kind})", null)
                }
            }
        }
    }
}

// MARK: - Text (line numbers)

/**
 * Monospaced text with a line-number gutter. Lines wrap (mobile beats
 * horizontal scrolling); the target line gets an amber highlight and is
 * centred once on open. A `LazyColumn` rather than one `Text`: fs/read
 * serves up to 1 MiB, and laying out one 20k-line paragraph on every
 * refresh is what the web avoids by keying on the scroll top.
 *
 * Scroll position survives a live refresh for free: the list state
 * holds a first-visible INDEX, and content replaced under it keeps that
 * index (clamped if the file shrank) — the equivalent of the web's
 * capture-`scrollTop`-then-restore in a layout effect.
 *
 * Deliberately unhighlighted: the web uses shiki and iOS Highlightr, but
 * this app carries no highlighter dependency and one is not being added
 * for the preview alone.
 */
@Composable
private fun TextFileView(content: String, targetLine: Int?, modifier: Modifier = Modifier) {
    val lines = remember(content) { content.split('\n') }
    val listState = rememberLazyListState()
    val highlight = argusPalette.toolAmber.copy(alpha = 0.22f)
    val gutter = tertiaryTextColor
    val body = MaterialTheme.colorScheme.onSurface

    // Keyed on the citation, not the content: a re-read re-applies the
    // marker (the row is recomposed) but only a NEW citation re-scrolls,
    // so a refresh never yanks the reader off the spot they scrolled to.
    LaunchedEffect(targetLine) {
        val line = targetLine ?: return@LaunchedEffect
        if (line < 1 || line > lines.size) return@LaunchedEffect
        // Give the list a beat to measure before the long-distance jump.
        delay(80)
        // A negative offset lands the item BELOW the top edge — the list
        // fills the space above it with the preceding rows — which is
        // how the target ends up mid-viewport rather than pinned to the top.
        val half = listState.layoutInfo.viewportSize.height / 2
        listState.scrollToItem(index = line - 1, scrollOffset = -half)
    }

    LazyColumn(
        state = listState,
        modifier = modifier,
        contentPadding = PaddingValues(vertical = 10.dp),
    ) {
        itemsIndexed(lines) { index, line ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(if (targetLine == index + 1) highlight else Color.Transparent)
                    .padding(top = 1.dp, bottom = 1.dp, end = 12.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Text(
                    text = "${index + 1}",
                    modifier = Modifier.width(42.dp),
                    style = monoStyle(11.sp),
                    color = gutter,
                    textAlign = TextAlign.End,
                    maxLines = 1,
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    // An empty line still needs a glyph to keep its height.
                    text = line.ifEmpty { " " },
                    modifier = Modifier.weight(1f),
                    style = monoStyle(12.sp),
                    color = body,
                )
            }
        }
    }
}

// MARK: - Markdown (.md files)

/**
 * A `.md` file through the same Markwon surface as answers (GFM + math),
 * matching the web FileViewer's markdown preview, which reuses the
 * transcript's plugin set. Single-dollar inline math gets the same
 * rewrite the answer path applies — the web's trade (a README's "$5 and
 * $10" can false-positive) is accepted here identically.
 *
 * Links: http/mailto go to the system; `path:line`-shaped links stay
 * inert — one preview is open at a time and nesting them is not worth a
 * second sheet.
 */
@Composable
private fun MarkdownFileView(content: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val markdown = remember(content) { MarkwonMath.rewriteInline(content) }
    Column(
        modifier = modifier
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        MarkwonText(
            markdown = markdown,
            modifier = Modifier.fillMaxWidth(),
            onLink = { link -> handleAnswerLink(context, link) { _, _ -> } },
        )
    }
}

// MARK: - HTML preview (.html files)

/**
 * Rendered HTML for remote-tree files — strictly SCRIPT-LESS, the
 * WebView analogue of the web FileViewer's `sandbox=""` posture and the
 * iOS StaticHtmlView: remote file content stays fully inert (no JS, no
 * navigation, no file or content-provider access, an opaque origin via
 * the null base URL). This is deliberately NOT the chat code-block
 * preview (`HtmlBlock`), which allows scripts for model-generated
 * Chart.js pages. `prepareHtmlDocument` is shared with that block so
 * the viewport pin + colour-scheme hint stay identical across clients.
 */
@Composable
private fun StaticHtmlView(html: String, modifier: Modifier = Modifier) {
    val dark = argusPalette.isDark
    AndroidView(
        factory = { ctx -> createStaticWebView(ctx) },
        modifier = modifier,
        update = { view ->
            // Content-deduped: `update` re-runs on every recomposition.
            val key = html to dark
            if (view.tag != key) {
                view.tag = key
                view.loadDataWithBaseURL(null, prepareHtmlDocument(html, dark), "text/html", "utf-8", null)
            }
        },
        onRelease = { view -> view.destroy() },
    )
}

private fun createStaticWebView(context: Context): WebView = WebView(context).apply {
    settings.javaScriptEnabled = false
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.setGeolocationEnabled(false)
    setBackgroundColor(android.graphics.Color.TRANSPARENT)
    webViewClient = object : WebViewClient() {
        /**
         * Belt-and-braces with JS off: cancel every navigation, so links
         * in the document go nowhere. `loadDataWithBaseURL` itself does
         * not route through here.
         */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
    }
}

// MARK: - Images

/** fs/read returns image bytes base64-encoded; decode off the main thread, then zoom. */
@Composable
private fun Base64ImagePreview(base64: String, contentDescription: String) {
    var bitmap by remember(base64) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(base64) { mutableStateOf(false) }
    LaunchedEffect(base64) {
        val decoded = withContext(Dispatchers.Default) {
            val bytes = try {
                Base64.decode(base64, Base64.DEFAULT)
            } catch (_: IllegalArgumentException) {
                null
            }
            bytes?.let { decodeImageBytes(it) }
        }
        if (decoded == null) failed = true else bitmap = decoded
    }
    val current = bitmap
    when {
        current != null -> ZoomableImage(current, contentDescription, Modifier.fillMaxSize())
        failed -> CenteredUnavailable("Couldn't decode image", null)
        else -> CenteredProgress()
    }
}

/**
 * Pinch-to-zoom + drag + double-tap image — deliberately simple (no
 * custom gesture arbitration) but enough to read a screenshot. Port of
 * the iOS ZoomableAsyncImage's gesture model: the scale clamps to
 * 1×–6×, panning only applies while zoomed, and a double tap toggles
 * between 1× and 2.5×. Shared with the attachment viewer.
 */
@Composable
internal fun ZoomableImage(bitmap: ImageBitmap, contentDescription: String?, modifier: Modifier = Modifier) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val transform = rememberTransformableState { zoomChange, panChange, _ ->
        val next = (scale * zoomChange).coerceIn(1f, 6f)
        scale = next
        offset = if (next > 1f) offset + panChange else Offset.Zero
    }
    Box(
        modifier = modifier
            .clipToBounds()
            .transformable(transform)
            .pointerInput(Unit) {
                detectTapGestures(
                    onDoubleTap = {
                        if (scale > 1f) {
                            scale = 1f
                            offset = Offset.Zero
                        } else {
                            scale = 2.5f
                        }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            bitmap = bitmap,
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxSize()
                // Read in the layer block, not the composition, so a
                // pinch redraws without recomposing the sheet.
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
        )
    }
}

/**
 * Bytes → bitmap, sub-sampled so a huge PNG never becomes a huge
 * bitmap. Null when the bytes aren't a decodable image.
 */
internal fun decodeImageBytes(bytes: ByteArray): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val width = bounds.outWidth
    val height = bounds.outHeight
    if (width <= 0 || height <= 0) return null
    var sample = 1
    while (width / sample > MAX_DECODED_EDGE || height / sample > MAX_DECODED_EDGE) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
}

// MARK: - Shared atoms (also used by AttachmentPreviewSheet and the inspector)

/** Copy-to-clipboard that reads "Copied" for ~1.5 s — the answer blocks' CopyAction. */
@Composable
private fun CopyTextAction(text: String) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    TextButton(
        onClick = {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            clipboard?.setPrimaryClip(ClipData.newPlainText("file", text))
            copied = true
        },
    ) {
        Text(if (copied) "Copied" else "Copy", style = MaterialTheme.typography.labelSmall)
    }
}

/** The ContentUnavailableView analogue: a centred title with an optional detail line. */
@Composable
internal fun CenteredUnavailable(title: String, detail: String?, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.padding(24.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall, color = secondaryTextColor)
            if (!detail.isNullOrEmpty()) {
                Text(
                    detail,
                    style = captionStyle(),
                    color = tertiaryTextColor,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
internal fun CenteredProgress(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

/** `512 B`, `3.4 KB`, `1.2 MB` — the web FileTree's formatSize. */
internal fun formatBytes(count: Long): String {
    val kb = 1024.0
    val mb = kb * 1024
    val gb = mb * 1024
    return when {
        count < 1024 -> "$count B"
        count < mb -> String.format(Locale.ROOT, "%.1f KB", count / kb)
        count < gb -> String.format(Locale.ROOT, "%.1f MB", count / mb)
        else -> String.format(Locale.ROOT, "%.1f GB", count / gb)
    }
}
