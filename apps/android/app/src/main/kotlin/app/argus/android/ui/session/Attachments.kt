package app.argus.android.ui.session

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.materialIcon
import androidx.compose.material.icons.materialPath
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.AppModel
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.model.AttachmentDTO
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer

// The composer's attachment flow (pick → upload → chip → send) and the
// thumbnails a sent turn shows — the Android counterpart of the
// attachment half of apps/ios/Argus/Sources/Views/SessionView.swift
// (`pendingAttachments` / `uploadsInFlight` / `attachmentChips` / `upload`
// and TurnBand's `attachmentRow`) and of the web's Composer.tsx
// `AttachmentChip` + StreamViewer.tsx `AttachmentBubble`.
//
// The model, from AGENTS.md ("Attachments are two separate problems"):
// a file is uploaded to the server the moment it is picked (`POST
// /attachments`, bytes into S3/MinIO, an unlinked Attachment row), and
// only its ID rides the turn — `CreateCommandRequest.attachmentIds`. So
// the composer holds a list of already-uploaded ids, the send button
// waits while uploads are in flight, and a sent turn's thumbnails are
// re-fetched from the server over the tokenized `AttachmentDTO.url`
// (the token IS the credential; no Authorization header).

/** Chip / thumbnail edge on both the composer and the sent turn (web `h-14 w-14`, iOS 56pt). */
private val THUMB_SIZE = 56.dp

/** The non-image chip: doc glyph + filename (web `w-36`, iOS 140pt). */
private val DOC_CHIP_WIDTH = 140.dp
private val ChipShape = RoundedCornerShape(10.dp)

/** How far the remove badge pokes past the chip's top-right corner (iOS `offset(x: 6, y: -6)`). */
private val REMOVE_OVERHANG = 6.dp

/** iOS's `maxSelectionCount: 5` on the photo picker. */
private const val MAX_PHOTOS = 5

/**
 * Sanity ceiling on bytes read into memory per picked file. The server's
 * cap is config-driven (`ATTACHMENT_MAX_FILE_BYTES`, default 25 MiB) and
 * its 413 stays the authority for everything under this — the ceiling
 * only exists so a mis-pick of a 2 GB video can't OOM the process while
 * being read just to be refused.
 */
private const val MAX_READ_BYTES = 32L * 1024 * 1024

private const val CONNECT_TIMEOUT_MS = 10_000
private const val READ_TIMEOUT_MS = 20_000

/** One uploaded-but-unsent attachment (the server already holds the bytes). */
class UploadedAttachment(
    val id: String,
    val filename: String,
    val isImage: Boolean,
    /** `AttachmentDTO.url` — API-base-relative and tokenized; carried so a caller can preview it. */
    val url: String?,
    /**
     * Local thumbnail decoded from the bytes in hand — instant, like the
     * web's object-URL previews and iOS's `byPreparingThumbnail`; null
     * for non-images. Deliberately NOT part of what survives queueing:
     * a queued prompt carries ids only.
     */
    val thumbnail: ImageBitmap?,
)

/**
 * State + actions for the composer's attachments. Remembered per session
 * by the caller via [rememberAttachmentUploader]; [pending] and
 * [inFlight] are snapshot state, so a composable that reads them
 * recomposes as uploads land.
 *
 * Uploads run on the uploader's own scope rather than a composition
 * scope so a recomposition (or the chips row briefly unmounting) can
 * never cancel a multipart POST halfway. Nothing cancels them on
 * dispose either: an upload that outlives its screen simply appends to
 * a list nobody renders, which is harmless, whereas cancelling would
 * leave a half-uploaded row on the server with no client to retry it.
 */
class AttachmentUploader internal constructor(
    private val app: AppModel,
    private val contentResolver: ContentResolver,
    /** Chip edge in device pixels — what the local thumbnail is sub-sampled towards. */
    private val thumbnailEdgePx: Int,
    private val onError: (String) -> Unit,
) {
    private val _pending = mutableStateListOf<UploadedAttachment>()

    /** Uploaded, not yet sent. Snapshot-backed: reads inside composition subscribe. */
    val pending: List<UploadedAttachment>
        get() = _pending

    /** Uploads still in progress — the send button waits on zero (iOS `uploadsInFlight`). */
    var inFlight: Int by mutableIntStateOf(0)
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // Wired by rememberAttachmentUploader: the system pickers are
    // activity-result launchers, which only exist inside a composition.
    internal var launchPhotoPicker: (() -> Unit)? = null
    internal var launchFilePicker: (() -> Unit)? = null

    fun remove(id: String) {
        _pending.removeAll { it.id == id }
    }

    /**
     * Ids of everything pending, and clears the list — the caller sends
     * them. An upload that lands AFTER this call appends to the (now
     * empty) list and rides the next send, exactly as on iOS; the caller
     * gates sending on `inFlight == 0` so that is a race it chose.
     */
    fun takeAll(): List<String> {
        val ids = _pending.map { it.id }
        _pending.clear()
        return ids
    }

    /** System photo picker, up to [MAX_PHOTOS] images. */
    fun pickPhotos() {
        launchPhotoPicker?.invoke()
    }

    /** System document picker, multiple, any type. */
    fun pickFiles() {
        launchFilePicker?.invoke()
    }

    internal fun uploadPhotos(uris: List<Uri>) {
        // The picker enforces the cap where the platform one exists; the
        // pre-13 fallbacks (GMS-backed picker / ACTION_GET_CONTENT) do not.
        uris.take(MAX_PHOTOS).forEachIndexed { index, uri ->
            upload(uri) { ext -> "photo-${index + 1}.$ext" }
        }
    }

    internal fun uploadFiles(uris: List<Uri>) {
        uris.forEachIndexed { index, uri ->
            upload(uri) { ext -> "file-${index + 1}.$ext" }
        }
    }

    /**
     * One file, one coroutine: read + thumbnail off-main, POST, append.
     * [fallbackName] names a file whose provider reports no display name
     * (the extension comes from the resolved mime).
     */
    private fun upload(uri: Uri, fallbackName: (ext: String) -> String) {
        // The composer is only reachable while logged in, so a missing
        // client is a teardown race rather than a user-facing failure
        // (iOS: `guard let client = app.client else { return }`).
        val client = app.client ?: return
        inFlight += 1
        scope.launch {
            try {
                val (picked, thumbnail) = withContext(Dispatchers.IO) {
                    val file = readPicked(uri, fallbackName)
                    // Decoding is attempted for every file — a non-image
                    // fails at the header and costs nothing, and the
                    // provider's mime is not trustworthy enough to gate on.
                    file to decodeScaled(file.bytes, thumbnailEdgePx)
                }
                val attachment = client.uploadAttachment(picked.name, picked.mime, picked.bytes)
                _pending += UploadedAttachment(
                    id = attachment.id,
                    filename = attachment.filename,
                    isImage = attachment.mime.startsWith("image/"),
                    url = attachment.url,
                    thumbnail = thumbnail,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // 401 funnels to logout; everything else (the 413 text,
                // a transport error, a provider that refused the read)
                // surfaces in the composer's error line.
                app.handleApiError(e)
                onError((e as? ApiError)?.message ?: e.message ?: "upload failed")
            } finally {
                inFlight -= 1
            }
        }
    }

    private class PickedFile(val name: String, val mime: String, val bytes: ByteArray)

    /** A pick we refuse before it reaches the network; the message is user-facing. */
    private class PickRejected(message: String) : Exception(message)

    /**
     * Resolve name, mime and bytes for a picked `content://` URI. The
     * grant on a picker result is temporary, which is fine: the bytes
     * are read here, immediately, and never re-opened.
     */
    private fun readPicked(uri: Uri, fallbackName: (ext: String) -> String): PickedFile {
        val displayName = queryDisplayName(uri)?.takeIf { it.isNotBlank() }
        // Some providers answer `*/*` or a bare token; only a real type is trusted.
        val providerMime = contentResolver.getType(uri)?.takeIf { it.contains('/') && !it.contains('*') }
        val extension = displayName?.substringAfterLast('.', "")?.lowercase()?.takeIf { it.isNotEmpty() }
        val mime = providerMime
            ?: extension?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
            ?: "application/octet-stream"
        val name = displayName
            // A last segment with a dot is a real filename; a bare row id is not.
            ?: uri.lastPathSegment?.takeIf { it.contains('.') }
            ?: fallbackName(MimeTypeMap.getSingleton().getExtensionFromMimeType(mime) ?: "bin")
        val stream = contentResolver.openInputStream(uri) ?: throw PickRejected("couldn't open $name")
        val bytes = stream.use { it.readBounded(MAX_READ_BYTES) }
            ?: throw PickRejected("$name is too large to upload (over ${MAX_READ_BYTES shr 20} MiB)")
        return PickedFile(name, mime, bytes)
    }

    private fun queryDisplayName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
        }
    }.getOrNull()
}

/**
 * The composer's uploader, remembered for the [app]. [onError] receives
 * the user-facing message of a failed upload (the server's 413 text, a
 * refused read, a transport error); it is read through
 * `rememberUpdatedState` so the latest lambda always fires.
 *
 * The two system pickers are activity-result launchers — composition
 * objects — so they are registered here and handed to the uploader
 * through a `SideEffect` after every composition, rather than the
 * uploader owning them. No permission is involved: the photo picker and
 * `ACTION_OPEN_DOCUMENT` both hand back URIs the app may read without
 * `READ_MEDIA_*` / `READ_EXTERNAL_STORAGE`.
 */
@Composable
fun rememberAttachmentUploader(app: AppModel, onError: (String) -> Unit): AttachmentUploader {
    // Application context: the uploader outlives compositions and must
    // not pin the Activity.
    val resolver = LocalContext.current.applicationContext.contentResolver
    val currentOnError = rememberUpdatedState(onError)
    val thumbnailEdgePx = with(LocalDensity.current) { THUMB_SIZE.roundToPx() }
    val uploader = remember(app) {
        AttachmentUploader(app, resolver, thumbnailEdgePx) { message -> currentOnError.value(message) }
    }
    val photoLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_PHOTOS),
    ) { uris -> uploader.uploadPhotos(uris) }
    val fileLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris -> uploader.uploadFiles(uris) }
    SideEffect {
        uploader.launchPhotoPicker = {
            photoLauncher.launch(
                PickVisualMediaRequest.Builder()
                    .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    .build(),
            )
        }
        uploader.launchFilePicker = { fileLauncher.launch(arrayOf("*/*")) }
    }
    return uploader
}

// MARK: Composer widgets

/**
 * The paperclip. A two-item menu ("Photos" / "Files") stands in for
 * iOS's confirmation dialog: the photo picker and the document picker
 * are different system surfaces, and one button that always opened the
 * document picker would hide the photo grid most attachments come from.
 * Sized like the iOS pill's 32pt actions — it sits INSIDE the composer
 * pill. A plain clipped Box rather than a Material `IconButton`, which
 * measures its 48dp minimum interactive size regardless of a smaller
 * `size` constraint and would spill its ripple past the pill (see
 * `PillAction` in SessionScreen.kt); Compose still expands the touch
 * bounds of a small pointer node to 48dp at hit-test time.
 */
@Composable
fun AttachButton(uploader: AttachmentUploader, enabled: Boolean, modifier: Modifier = Modifier) {
    var menuOpen by remember { mutableStateOf(false) }
    Box(modifier) {
        Box(
            modifier = Modifier
                .size(32.dp)
                .clip(CircleShape)
                .clickable(enabled = enabled, role = Role.Button) { menuOpen = true },
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                AttachFileIcon,
                contentDescription = "Attach",
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (enabled) 1f else 0.38f),
                modifier = Modifier.size(18.dp),
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(text = { Text("Photos") }, onClick = { menuOpen = false; uploader.pickPhotos() })
            DropdownMenuItem(text = { Text("Files") }, onClick = { menuOpen = false; uploader.pickFiles() })
        }
    }
}

/**
 * Pending uploads as 56dp chips (thumbnail, or doc chip for non-images)
 * with a remove badge, plus a spinner slot while anything is still
 * uploading (iOS `attachmentChips`). Renders nothing when there is
 * nothing to show, so the composer's column spacing doesn't reserve an
 * empty row.
 *
 * The remove badge overhangs each chip's top-right corner; the row pads
 * itself by that overhang on top and at the end so the horizontal
 * scroller's clip doesn't shave the badge off the first and last chips.
 */
@Composable
fun AttachmentChipsRow(uploader: AttachmentUploader, modifier: Modifier = Modifier) {
    val pending = uploader.pending
    val inFlight = uploader.inFlight
    if (pending.isEmpty() && inFlight == 0) return
    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(top = REMOVE_OVERHANG, end = REMOVE_OVERHANG),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (attachment in pending) {
            key(attachment.id) {
                PendingChip(attachment = attachment, onRemove = { uploader.remove(attachment.id) })
            }
        }
        if (inFlight > 0) {
            Box(modifier = Modifier.size(THUMB_SIZE), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            }
        }
    }
}

/**
 * One pending chip. iOS falls back to loading the server copy when the
 * local thumbnail is nil; that is deliberately not ported — the server
 * serves the very bytes we just failed to decode, so the fetch could
 * only fail the same way. An undecodable image shows the doc chip.
 */
@Composable
private fun PendingChip(attachment: UploadedAttachment, onRemove: () -> Unit) {
    Box {
        val thumbnail = attachment.thumbnail
        if (thumbnail != null) {
            Image(
                bitmap = thumbnail,
                contentDescription = attachment.filename,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(THUMB_SIZE)
                    .clip(ChipShape)
                    .border(1.dp, hairlineColor(), ChipShape),
            )
        } else {
            DocChip(filename = attachment.filename, onClick = null)
        }
        RemoveBadge(
            onRemove = onRemove,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .offset(x = REMOVE_OVERHANG, y = -REMOVE_OVERHANG),
        )
    }
}

/** iOS's `xmark.circle.fill` — white × on a translucent black disc, always visible (no hover on touch). */
@Composable
private fun RemoveBadge(onRemove: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(20.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.6f))
            .border(1.dp, Color.White.copy(alpha = 0.85f), CircleShape)
            .clickable(onClick = onRemove),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = Icons.Filled.Close,
            contentDescription = "Remove",
            modifier = Modifier.size(12.dp),
            tint = Color.White,
        )
    }
}

// MARK: Sent-turn thumbnails

/**
 * The attachments of a SENT turn, rendered above its prompt bubble (web
 * user-message order, iOS `TurnBand.attachmentRow`): 56dp image
 * thumbnails fetched from the tokenized URL, doc chips for everything
 * else, each tapping through to [onOpen]. [absoluteUrl] turns the DTO's
 * API-relative path into a fetchable URL (null when there is no client,
 * in which case the image degrades to a doc chip that still opens).
 *
 * Left-aligned, unlike iOS's trailing anchor: the Android prompt bubble
 * is full-width, so there is no right edge for the row to hang off.
 */
@Composable
fun TurnAttachmentThumbs(
    attachments: List<AttachmentDTO>,
    absoluteUrl: (String) -> String?,
    onOpen: (AttachmentDTO) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (attachments.isEmpty()) return
    val targetEdgePx = with(LocalDensity.current) { THUMB_SIZE.roundToPx() }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (attachment in attachments) {
            key(attachment.id) {
                val url = if (attachment.mime.startsWith("image/")) absoluteUrl(attachment.url) else null
                if (url != null) {
                    RemoteImageThumb(
                        url = url,
                        contentDescription = attachment.filename,
                        targetEdgePx = targetEdgePx,
                        modifier = Modifier
                            .size(THUMB_SIZE)
                            .clip(ChipShape)
                            .border(1.dp, hairlineColor(), ChipShape)
                            .clickable { onOpen(attachment) },
                    )
                } else {
                    DocChip(filename = attachment.filename, onClick = { onOpen(attachment) })
                }
            }
        }
    }
}

/**
 * An image attachment loaded over HTTP. The cache is read synchronously
 * first so a turn scrolled back into view paints its thumbnail on the
 * first frame instead of flashing the placeholder; only a miss suspends.
 * Loading and failure both show the neutral tile (failure adds a dim
 * frame glyph) — a broken-image icon would shout about what is usually
 * an expired display token.
 */
@Composable
private fun RemoteImageThumb(
    url: String,
    contentDescription: String,
    targetEdgePx: Int,
    modifier: Modifier = Modifier,
) {
    var thumb by remember(url) { mutableStateOf(RemoteThumbCache.cached(url)) }
    LaunchedEffect(url) {
        if (thumb == null) thumb = RemoteThumbCache.load(url, targetEdgePx)
    }
    when (val state = thumb) {
        is RemoteThumb.Ready -> Image(
            bitmap = state.bitmap,
            contentDescription = contentDescription,
            contentScale = ContentScale.Crop,
            modifier = modifier,
        )
        else -> Box(
            modifier = modifier.background(argusPalette.surface2),
            contentAlignment = Alignment.Center,
        ) {
            if (state == RemoteThumb.Failed) {
                Box(Modifier.size(14.dp).border(1.dp, tertiaryTextColor, RoundedCornerShape(2.dp)))
            }
        }
    }
}

/**
 * The non-image chip: 140×56, doc glyph + one-line filename on surface2
 * (web `AttachmentChip`'s file branch, iOS's `doc.text` HStack). Shared
 * by the composer (no tap) and the sent turn (tap opens the preview).
 */
@Composable
private fun DocChip(filename: String, onClick: (() -> Unit)?) {
    Row(
        modifier = Modifier
            .width(DOC_CHIP_WIDTH)
            .height(THUMB_SIZE)
            .clip(ChipShape)
            .background(argusPalette.surface2)
            .border(1.dp, hairlineColor(), ChipShape)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = DocumentIcon,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = tertiaryTextColor,
        )
        Text(
            text = filename,
            style = captionStyle().copy(fontSize = 11.sp),
            color = secondaryTextColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The web's `border-default` / iOS `Color(.separator)` on a thumbnail. */
@Composable
private fun hairlineColor(): Color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)

// MARK: Remote thumbnail cache

private sealed interface RemoteThumb {
    class Ready(val bitmap: ImageBitmap) : RemoteThumb

    data object Failed : RemoteThumb
}

/**
 * Decoded sent-turn thumbnails, process-wide, keyed by the tokenized URL
 * — the same shape as `WorkspaceImageCache`: concurrent first loads of
 * one key are deduped, and a load runs in the cache's own scope so a
 * row leaving the LazyColumn mid-fetch neither cancels it for the other
 * waiters nor loses the result.
 *
 * Keyed by URL rather than attachment id on purpose. The display token
 * in the URL is short-lived (1 h), so a transcript reloaded later
 * carries fresh URLs — and a FAILURE cached under the old, expired URL
 * must not shadow them. Successes are re-fetched once per token
 * rotation, which is the cheap side of that trade. Failures are cached
 * too: a 4xx repeats identically, and re-issuing it on every recompose
 * made a dead thumbnail flicker.
 *
 * Small and access-ordered (true LRU): 32 entries at chip size is under
 * a megabyte even at 4× density.
 */
private object RemoteThumbCache {
    private const val MAX_ENTRIES = 32

    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** accessOrder = true, so `get` refreshes recency and the first key is the coldest. */
    private val settled = LinkedHashMap<String, RemoteThumb>(MAX_ENTRIES, 0.75f, true)
    private val inflight = HashMap<String, Deferred<RemoteThumb>>()

    fun cached(url: String): RemoteThumb? = synchronized(lock) { settled[url] }

    suspend fun load(url: String, targetEdgePx: Int): RemoteThumb {
        cached(url)?.let { return it }
        val job = synchronized(lock) {
            inflight[url] ?: scope.async { settle(url, targetEdgePx) }.also { inflight[url] = it }
        }
        return job.await()
    }

    private fun settle(url: String, targetEdgePx: Int): RemoteThumb {
        val result: RemoteThumb = try {
            fetch(url)?.let { decodeScaled(it, targetEdgePx) }?.let { RemoteThumb.Ready(it) } ?: RemoteThumb.Failed
        } catch (e: Exception) {
            RemoteThumb.Failed
        }
        synchronized(lock) {
            inflight.remove(url)
            settled[url] = result
            while (settled.size > MAX_ENTRIES) settled.remove(settled.keys.first())
        }
        return result
    }

    /**
     * Plain `HttpURLConnection`: the URL authenticates itself via `?t=`,
     * and the app carries no image-loading library. Null on any non-2xx
     * (an expired token is a 401 here) or an over-ceiling body.
     */
    private fun fetch(url: String): ByteArray? {
        val connection = URL(url).openConnection() as? HttpURLConnection ?: return null
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        try {
            if (connection.responseCode !in 200..299) return null
            return connection.inputStream.use { it.readBounded(MAX_READ_BYTES) }
        } finally {
            connection.disconnect()
        }
    }
}

// MARK: Decoding

/**
 * Decode [bytes] sub-sampled so the SHORTER edge lands at or above
 * [targetEdgePx] (the chips crop to a square, so the short edge is what
 * fills it); null when the bytes aren't a decodable image.
 *
 * On P+ this goes through `ImageDecoder`, which applies EXIF orientation
 * itself — `BitmapFactory` does not, and a camera-roll JPEG would land
 * sideways in the chip — and decodes HEIF, the default camera format on
 * many phones. Below P, `BitmapFactory` with `inSampleSize` is what
 * there is; an unrotated thumbnail is the accepted cost on those two
 * API levels. Software allocation so the bitmap can be drawn anywhere.
 */
private fun decodeScaled(bytes: ByteArray, targetEdgePx: Int): ImageBitmap? {
    val bitmap = try {
        decodeBitmap(bytes, targetEdgePx)
    } catch (e: Exception) {
        // ImageDecoder.DecodeException (an IOException) for non-image
        // bytes; anything else from a hostile file is equally "no thumb".
        null
    }
    return bitmap?.asImageBitmap()
}

private fun decodeBitmap(bytes: ByteArray, targetEdgePx: Int): Bitmap? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val source = ImageDecoder.createSource(ByteBuffer.wrap(bytes))
        return ImageDecoder.decodeBitmap(
            source,
            ImageDecoder.OnHeaderDecodedListener { decoder, info, _ ->
                decoder.setTargetSampleSize(sampleSize(info.size.width, info.size.height, targetEdgePx))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            },
        )
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val options = BitmapFactory.Options().apply {
        inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, targetEdgePx)
    }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
}

/** Largest power-of-two sample that keeps both edges at or above [targetEdgePx]. */
private fun sampleSize(width: Int, height: Int, targetEdgePx: Int): Int {
    val target = maxOf(1, targetEdgePx)
    var sample = 1
    while (width / (sample * 2) >= target && height / (sample * 2) >= target) sample *= 2
    return sample
}

/** Read everything, or null once the body exceeds [max] bytes. */
private fun InputStream.readBounded(max: Long): ByteArray? {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
        val n = read(buffer)
        if (n < 0) break
        total += n
        if (total > max) return null
        out.write(buffer, 0, n)
    }
    return out.toByteArray()
}

// MARK: Glyphs

// The app ships material-icons-core only (see ToolStyle), and that set
// has neither a paperclip nor a document — the two glyphs the web's
// lucide `Paperclip` / `FileText` and iOS's `paperclip` / `doc.text`
// map to. Material's `attach_file` and `insert_drive_file` path data
// (Apache 2.0, the same data the extended icon set compiles in) is
// inlined here through the icon library's own `materialIcon` builder.

private val AttachFileIcon: ImageVector by lazy {
    materialIcon(name = "Argus.AttachFile") {
        materialPath {
            moveTo(16.5f, 6.0f)
            verticalLineToRelative(11.5f)
            curveToRelative(0.0f, 2.21f, -1.79f, 4.0f, -4.0f, 4.0f)
            reflectiveCurveToRelative(-4.0f, -1.79f, -4.0f, -4.0f)
            verticalLineTo(5.0f)
            curveToRelative(0.0f, -1.38f, 1.12f, -2.5f, 2.5f, -2.5f)
            reflectiveCurveToRelative(2.5f, 1.12f, 2.5f, 2.5f)
            verticalLineToRelative(10.5f)
            curveToRelative(0.0f, 0.55f, -0.45f, 1.0f, -1.0f, 1.0f)
            reflectiveCurveToRelative(-1.0f, -0.45f, -1.0f, -1.0f)
            verticalLineTo(6.0f)
            horizontalLineTo(10.0f)
            verticalLineToRelative(9.5f)
            curveToRelative(0.0f, 1.38f, 1.12f, 2.5f, 2.5f, 2.5f)
            reflectiveCurveToRelative(2.5f, -1.12f, 2.5f, -2.5f)
            verticalLineTo(5.0f)
            curveToRelative(0.0f, -2.21f, -1.79f, -4.0f, -4.0f, -4.0f)
            reflectiveCurveTo(7.0f, 2.79f, 7.0f, 5.0f)
            verticalLineToRelative(12.5f)
            curveToRelative(0.0f, 3.04f, 2.46f, 5.5f, 5.5f, 5.5f)
            reflectiveCurveToRelative(5.5f, -2.46f, 5.5f, -5.5f)
            verticalLineTo(6.0f)
            horizontalLineToRelative(-1.5f)
            close()
        }
    }
}

private val DocumentIcon: ImageVector by lazy {
    materialIcon(name = "Argus.Document") {
        materialPath {
            moveTo(6.0f, 2.0f)
            curveToRelative(-1.1f, 0.0f, -1.99f, 0.9f, -1.99f, 2.0f)
            lineTo(4.0f, 20.0f)
            curveToRelative(0.0f, 1.1f, 0.89f, 2.0f, 1.99f, 2.0f)
            lineTo(18.0f, 22.0f)
            curveToRelative(1.1f, 0.0f, 2.0f, -0.9f, 2.0f, -2.0f)
            lineTo(20.0f, 8.0f)
            lineToRelative(-6.0f, -6.0f)
            lineTo(6.0f, 2.0f)
            close()
            moveTo(13.0f, 9.0f)
            lineTo(13.0f, 3.5f)
            lineTo(18.5f, 9.0f)
            lineTo(13.0f, 9.0f)
            close()
        }
    }
}
