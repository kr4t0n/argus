package app.argus.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.ui.theme.argusPalette
import app.argus.core.engine.DiffLine
import app.argus.core.engine.DiffLineKind
import app.argus.core.engine.DiffLines

/**
 * Renders a unified diff with per-line colours (green adds / red removes /
 * neutral context) plus a hunk header — the Compose counterpart of the
 * web's `components/ui/DiffBlock.tsx` and iOS `DiffText`. Classification
 * is `DiffLines` in :core; this only paints. The sidecar emits the diff
 * for every file-editing tool (`meta.isDiff`); the client never re-diffs.
 *
 * The `--- a/…` / `+++ b/…` file headers are skipped because the caller
 * (the tool row) already names the file — showing them again is noise
 * (web parity). A header row carries the `+N −M` counts instead.
 *
 * Long lines scroll sideways rather than wrapping so a diff reads as
 * columns; [maxHeight] caps the block with its own vertical scroll (the
 * default keeps an inline tool-row diff compact). Pass `null` when the
 * block sits inside a pane that owns its own scroll, so the diff expands
 * fully instead of nesting a second scrollbar.
 */
@Composable
fun DiffBlock(
    diff: String,
    modifier: Modifier = Modifier,
    maxHeight: Dp? = 320.dp,
) {
    val lines = remember(diff) { DiffLines.parse(diff) }
    val counts = remember(diff) { DiffLines.counts(diff) }
    val palette = argusPalette
    val tertiary = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f)
    val mono = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 11.sp,
        lineHeight = 16.sp,
    )

    Column(
        modifier
            .clip(RoundedCornerShape(6.dp))
            .background(palette.surface1.copy(alpha = 0.5f)),
    ) {
        // `+N −M` badge. The minus is U+2212 so it lines up with the plus
        // in a mono face (an ASCII hyphen is visibly shorter).
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "+${counts.added}",
                style = mono.copy(fontWeight = FontWeight.SemiBold),
                color = palette.diffAddFg,
            )
            Text(
                text = "−${counts.removed}",
                style = mono.copy(fontWeight = FontWeight.SemiBold),
                color = palette.diffRemoveFg,
            )
        }

        // Width of the viewport is needed so the add/remove bars span the
        // full row even when every line is shorter than the block: inside
        // a horizontal scroll the column is only as wide as its widest
        // line (IntrinsicSize.Max), so the viewport is its floor.
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val viewport = maxWidth
            val vertical = if (maxHeight != null) {
                Modifier.heightIn(max = maxHeight).verticalScroll(rememberScrollState())
            } else {
                Modifier
            }
            Column(
                modifier = vertical
                    .horizontalScroll(rememberScrollState())
                    .widthIn(min = viewport)
                    .width(IntrinsicSize.Max)
                    .padding(bottom = 4.dp),
            ) {
                for (line in lines) {
                    if (isFileHeader(line)) continue
                    DiffRow(line = line, style = mono, tertiary = tertiary)
                }
            }
        }
    }
}

/** The `--- a/x` / `+++ b/x` pair — the tool row already names the file. */
private fun isFileHeader(line: DiffLine): Boolean =
    line.kind == DiffLineKind.META &&
        (line.text.startsWith("--- ") || line.text.startsWith("+++ "))

@Composable
private fun DiffRow(line: DiffLine, style: TextStyle, tertiary: Color) {
    val palette = argusPalette
    val fg: Color
    val bg: Color
    var italic = false
    when (line.kind) {
        DiffLineKind.ADD -> {
            fg = palette.diffAddFg
            bg = palette.diffAddBg
        }
        DiffLineKind.REMOVE -> {
            fg = palette.diffRemoveFg
            bg = palette.diffRemoveBg
        }
        DiffLineKind.HUNK -> {
            fg = palette.diffHunkFg
            bg = Color.Transparent
        }
        DiffLineKind.META -> {
            fg = tertiary
            bg = Color.Transparent
            italic = true
        }
        DiffLineKind.CONTEXT -> {
            fg = tertiary
            bg = Color.Transparent
        }
    }
    Text(
        // An empty line still needs a glyph to keep its height.
        text = line.text.ifEmpty { " " },
        modifier = Modifier
            .fillMaxWidth()
            .background(bg)
            .padding(horizontal = 10.dp),
        style = style,
        color = fg,
        fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
        softWrap = false,
        maxLines = 1,
    )
}
