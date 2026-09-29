@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.files

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.argus.android.AppModel
import app.argus.android.ui.session.captionStyle
import app.argus.android.ui.session.secondaryTextColor
import app.argus.core.model.AttachmentDTO
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Full-size viewer for a turn's uploaded attachment — the Android
 * counterpart of the iOS AttachmentPreviewSheet (FilePreview.swift). The
 * bytes live in the object store and are fetched through the server via
 * the DTO's tokenized URL (`/attachments/{id}?t=…`), so there is no
 * agent round-trip and no Authorization header: the `?t=` display token
 * IS the credential. Images pinch-zoom; anything else shows its name and
 * size and hands the URL to the system (`ACTION_VIEW`) — the iOS share
 * sheet's nearest Android equivalent without a download-manager
 * dependency.
 *
 * The display token in `AttachmentDTO.url` lives ~1 h from transcript
 * load — a very stale session may need re-opening before the fetch
 * succeeds, which is why an auth-shaped failure gets that specific
 * message rather than a bare HTTP code.
 */
@Composable
fun AttachmentPreviewSheet(app: AppModel, attachment: AttachmentDTO, onDismiss: () -> Unit) {
    // Null only mid-logout teardown; the presentation below says so
    // instead of crashing on a `!!`.
    val url = app.client?.absoluteUrl(attachment.url)
    val isImage = attachment.mime.startsWith("image/")

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            text = attachment.filename,
                            style = MaterialTheme.typography.titleSmall,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = onDismiss) {
                            Icon(Icons.Default.Close, contentDescription = "Close")
                        }
                    },
                )
            },
        ) { innerPadding ->
            Box(Modifier.fillMaxSize().padding(innerPadding)) {
                if (isImage && url != null) {
                    AttachmentImage(url = url, contentDescription = attachment.filename)
                } else {
                    AttachmentFilePresentation(attachment = attachment, url = url)
                }
            }
        }
    }
}

/**
 * Image bytes over plain HTTP(S) on the IO dispatcher — Coil/Glide are
 * not dependencies and one is not being added for a single viewer. The
 * fetch runs inside the composable's effect, so dismissing the sheet
 * cancels it.
 */
@Composable
private fun AttachmentImage(url: String, contentDescription: String) {
    var bitmap by remember(url) { mutableStateOf<ImageBitmap?>(null) }
    var loadError by remember(url) { mutableStateOf<String?>(null) }
    LaunchedEffect(url) {
        try {
            val bytes = withContext(Dispatchers.IO) { fetchBytes(url) }
            val decoded = withContext(Dispatchers.Default) { decodeImageBytes(bytes) }
            if (decoded == null) loadError = "Couldn't decode image" else bitmap = decoded
        } catch (e: CancellationException) {
            throw e
        } catch (_: ExpiredLinkException) {
            loadError = "The attachment link may have expired — reopen the session to refresh."
        } catch (e: Exception) {
            loadError = e.message ?: "Couldn't load image"
        }
    }
    val current = bitmap
    val failure = loadError
    when {
        current != null -> ZoomableImage(current, contentDescription, Modifier.fillMaxSize())
        failure != null -> CenteredUnavailable("Couldn't load image", failure)
        else -> CenteredProgress()
    }
}

/** Name, type · size, and an Open action that hands the tokenized URL to the system. */
@Composable
private fun AttachmentFilePresentation(attachment: AttachmentDTO, url: String?) {
    val context = LocalContext.current
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.padding(24.dp),
        ) {
            Text(
                attachment.filename,
                style = MaterialTheme.typography.titleMedium,
                textAlign = TextAlign.Center,
            )
            Text(
                "${attachment.mime} · ${formatBytes(attachment.size)}",
                style = captionStyle(),
                color = secondaryTextColor,
            )
            if (url != null) {
                Button(
                    onClick = {
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        } catch (_: ActivityNotFoundException) {
                            // Nothing installed to take it; the button stays a no-op.
                        }
                    },
                ) {
                    Text("Open")
                }
            } else {
                Text("Not connected", style = captionStyle(), color = secondaryTextColor)
            }
        }
    }
}

/** An auth-shaped HTTP failure on the tokenized URL — the display token has most likely expired. */
private class ExpiredLinkException(code: Int) : IOException("HTTP $code")

/**
 * GET the whole body. The URL carries its own token, so no headers are
 * set. 401/403/410 are surfaced as [ExpiredLinkException] so the caller
 * can word the failure; any other non-2xx is a plain IOException.
 */
private fun fetchBytes(url: String): ByteArray {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = true
        val code = connection.responseCode
        if (code == 401 || code == 403 || code == 410) throw ExpiredLinkException(code)
        if (code !in 200..299) throw IOException("HTTP $code")
        return connection.inputStream.use { it.readBytes() }
    } finally {
        connection.disconnect()
    }
}
