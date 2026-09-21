package app.argus.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.ui.theme.argusPalette
import app.argus.core.engine.FileReferences

/**
 * Chips for the files an agent touched in a turn (`Turn.touchedFiles`),
 * rendered after the answer like the web's `FileChips` and the iOS
 * `FileChipsRow` (apps/ios/Argus/Sources/Views/FilePreview.swift). Labels
 * are `FileReferences.displayPath` — the workingDir prefix stripped so the
 * chip shows the part that changes; an out-of-workspace path keeps its
 * absolute form because THAT is the signal.
 *
 * A chip is only tappable when `FileReferences.toAgentRelative` can turn
 * it into something `fs/read` accepts (inside the workspace, not a
 * directory); anything else renders dimmed and inert — the sidecar's fs
 * jail would refuse it anyway, so a tap could only produce an error.
 *
 * [onOpen] receives the RAW path and `null` for the line — touched files
 * come from tool inputs (`file_path` and friends), never `path:line`
 * citations, so there is no line to split off (iOS parity). Citations in
 * answer markdown are a different call site.
 */
@Composable
fun FileChipsRow(
    files: List<String>,
    workingDir: String?,
    onOpen: (path: String, line: Int?) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (file in files) {
            FileChip(file = file, workingDir = workingDir, onOpen = onOpen)
        }
    }
}

@Composable
private fun FileChip(
    file: String,
    workingDir: String?,
    onOpen: (path: String, line: Int?) -> Unit,
) {
    val interactive = FileReferences.toAgentRelative(file, workingDir) != null
    val label = FileReferences.displayPath(file, workingDir)
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        modifier = Modifier
            .alpha(if (interactive) 1f else 0.55f)
            .clip(RoundedCornerShape(7.dp))
            .background(argusPalette.surface1.copy(alpha = 0.6f))
            .clickable(enabled = interactive) { onOpen(file, null) }
            .padding(horizontal = 8.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.List,
            contentDescription = null,
            modifier = Modifier.size(10.dp),
            tint = secondary,
        )
        // Middle truncation: the tail of a path (the file name) is the
        // part worth keeping when the chip runs out of room.
        Text(
            text = label,
            modifier = Modifier.widthIn(max = 260.dp),
            style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 11.sp),
            color = secondary,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.MiddleEllipsis,
        )
    }
}
