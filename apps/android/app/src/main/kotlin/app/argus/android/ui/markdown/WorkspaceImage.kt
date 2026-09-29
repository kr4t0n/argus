package app.argus.android.ui.markdown

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.core.model.FSReadResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.CancellationException

/**
 * Inline rendering of `![alt](path)` for a path INSIDE the agent's
 * working directory — the Android counterpart of the web's custom `img`
 * renderer (`apps/web/src/components/MarkdownImage.tsx`) and iOS's
 * `WorkspaceMarkdownImage` (apps/ios/Argus/Sources/Views/MarkdownImage.swift).
 *
 * The file lives on the agent's machine, so the only way to show it is
 * the same fs/read RPC the file preview uses. `AnswerView` routes here
 * only for `MarkdownImageSource.Workspace`; remote URLs and inert paths
 * never reach this composable.
 *
 * GOTCHA (epoch): outcomes are cached by `(projectId, path, turnEpoch)`.
 * The epoch matters — an agent that regenerates `preview.png` next turn
 * emits the same path, and a path-only key would show the previous
 * turn's bytes. A live turn (null epoch) re-reads when it settles into
 * its own epoch.
 *
 * GOTCHA (failures): FAILURES are cached too, not just successes. A path
 * that isn't a readable image fails identically every time, and caching
 * only successes re-issued the doomed read on every remount — a missing
 * file flickered loading → not-found each time the row recomposed. The
 * trade-off is that a transient failure (machine offline) also sticks
 * for that turn's epoch.
 */
@Composable
fun WorkspaceImage(
    relativePath: String,
    alt: String,
    images: MarkdownImageContext,
    modifier: Modifier = Modifier,
) {
    val projectId = images.projectId
    val epoch = images.turnEpoch ?: "live"
    val key = WorkspaceImageCache.key(projectId ?: "", relativePath, epoch)

    // The outcome this composable loaded, tagged with the key it belongs
    // to, so an epoch flip (live → completed) can't keep showing the old
    // key's result while the new read is in flight.
    var loaded by remember { mutableStateOf<Pair<String, SettledImage>?>(null) }
    // The synchronous cache read is what keeps a re-created composable
    // from flashing the placeholder.
    val current = loaded?.takeIf { it.first == key }?.second ?: WorkspaceImageCache.cached(key)

    LaunchedEffect(projectId, relativePath, epoch) {
        WorkspaceImageCache.cached(key)?.let {
            loaded = key to it
            return@LaunchedEffect
        }
        if (projectId == null) {
            loaded = key to SettledImage.Error("no project")
            return@LaunchedEffect
        }
        val value = WorkspaceImageCache.load(key) { images.readFile(projectId, relativePath) }
        loaded = key to value
    }

    when (val state = current) {
        null -> ImageLoadingPlaceholder(text = relativePath, modifier = modifier)
        is SettledImage.Ready -> WorkspaceBitmap(state, alt.ifBlank { relativePath }, modifier)
        is SettledImage.Error -> InertImageLabel(text = relativePath, modifier = modifier, detail = state.message)
    }
}

/**
 * Web parity for the `<img>` box: never wider than the column, never
 * taller than 420dp, and never upscaled past the bitmap's own size
 * (`max-w-full max-h-[420px]` semantics, pixels read as dp the way iOS
 * reads them as points); rounded with the same border the html/mermaid
 * blocks use. The size is computed outright from the column width so
 * the frame hugs the picture instead of a letterboxed full-width box.
 */
@Composable
private fun WorkspaceBitmap(image: SettledImage.Ready, contentDescription: String, modifier: Modifier) {
    val border = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)
    val shape = RoundedCornerShape(8.dp)
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val intrinsicW: Dp = image.widthPx.dp
        val intrinsicH: Dp = image.heightPx.dp
        val scale = minOf(1f, maxWidth / intrinsicW, MAX_IMAGE_HEIGHT / intrinsicH)
        Image(
            bitmap = image.bitmap,
            contentDescription = contentDescription,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .size(width = intrinsicW * scale, height = intrinsicH * scale)
                .clip(shape)
                .border(1.dp, border, shape),
        )
    }
}

private val MAX_IMAGE_HEIGHT: Dp = 420.dp

/**
 * The fallback for an image we can't or won't fetch: outside the
 * workspace, no project, a non-http scheme, or a read that failed.
 * Deliberately inert — no tap target — and styled like the transcript's
 * other dimmed file references, so the reader still sees WHAT the agent
 * meant to show and where it put it. The frame glyph stands in for the
 * web's hover tooltip: on a phone it's the only cue this was an image.
 */
@Composable
internal fun InertImageLabel(
    text: String,
    modifier: Modifier = Modifier,
    detail: String? = null,
) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FrameGlyph(color = secondary)
        Text(
            text = text,
            color = secondary,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (detail != null) {
            Text(
                text = "— $detail",
                color = secondary.copy(alpha = 0.7f),
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A tiny outlined frame — the picture glyph, drawn rather than pulled from an icon set. */
@Composable
private fun FrameGlyph(color: androidx.compose.ui.graphics.Color) {
    Box(
        Modifier
            .size(12.dp)
            .border(1.dp, color, RoundedCornerShape(2.dp)),
    )
}

@Composable
private fun ImageLoadingPlaceholder(text: String, modifier: Modifier = Modifier) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val border = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f)
    Row(
        modifier = modifier
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawRoundRect(
                    color = border,
                    cornerRadius = CornerRadius(8.dp.toPx()),
                    style = Stroke(
                        width = stroke,
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
                    ),
                )
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = secondary)
        Text(
            text = text,
            color = secondary,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

// MARK: - Cache

/** A settled fs/read outcome for one image key. */
internal sealed interface SettledImage {
    /** Decoded (possibly sub-sampled) bitmap plus the file's own pixel size for the upscale guard. */
    class Ready(val bitmap: ImageBitmap, val widthPx: Int, val heightPx: Int) : SettledImage

    class Error(val message: String) : SettledImage
}

/**
 * Settled fs/read outcomes, process-wide, shared across every image
 * composable — the port of iOS `MarkdownImageCache`. Failures are cached
 * alongside successes (see the GOTCHA on [WorkspaceImage]). Concurrent
 * first loads of one key are deduped, and a load runs in the cache's own
 * scope so a composable leaving mid-read neither cancels it for the
 * other waiters nor loses the result.
 *
 * fs/read caps a file at 1 MiB, so worst case is ~16 decoded screenshots
 * held live; typical answers reference one or two.
 */
internal object WorkspaceImageCache {
    private const val MAX_CACHED = 16
    private const val MAX_DECODED_EDGE = 2048

    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Insertion-ordered for FIFO eviction — no access tracking needed. */
    private val settled = LinkedHashMap<String, SettledImage>()
    private val inflight = HashMap<String, Deferred<SettledImage>>()

    fun key(projectId: String, path: String, epoch: String): String = "$projectId\u0000$path\u0000$epoch"

    fun cached(key: String): SettledImage? = synchronized(lock) { settled[key] }

    suspend fun load(key: String, read: suspend () -> FSReadResult?): SettledImage {
        cached(key)?.let { return it }
        val job = synchronized(lock) {
            inflight[key] ?: scope.async { settle(key, read) }.also { inflight[key] = it }
        }
        return job.await()
    }

    private suspend fun settle(key: String, read: suspend () -> FSReadResult?): SettledImage {
        val result = try {
            decode(read())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The API error carries the sidecar's own wording — "file is
            // too large to preview (…)" for an over-cap read, which is the
            // failure full-resolution screenshots hit most.
            SettledImage.Error(e.message ?: "read failed")
        }
        synchronized(lock) {
            inflight.remove(key)
            if (!settled.containsKey(key)) {
                settled[key] = result
                while (settled.size > MAX_CACHED) {
                    settled.remove(settled.keys.first())
                }
            }
        }
        return result
    }

    /**
     * fs/read classifies by extension allowlist then content sniff, so
     * anything but `Image` means the path isn't a renderable image.
     * Decoded off the render path once, sub-sampled so a huge PNG never
     * becomes a huge bitmap; the original pixel size is kept for layout.
     */
    private fun decode(result: FSReadResult?): SettledImage {
        if (result == null) return SettledImage.Error("not connected")
        val image = result as? FSReadResult.Image ?: return SettledImage.Error("not an image file")
        val bytes = try {
            Base64.decode(image.base64, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            return SettledImage.Error("couldn't decode image")
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val width = bounds.outWidth
        val height = bounds.outHeight
        if (width <= 0 || height <= 0) return SettledImage.Error("couldn't decode image")
        var sample = 1
        while (width / sample > MAX_DECODED_EDGE || height / sample > MAX_DECODED_EDGE) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            ?: return SettledImage.Error("couldn't decode image")
        return SettledImage.Ready(bitmap.asImageBitmap(), width, height)
    }
}
