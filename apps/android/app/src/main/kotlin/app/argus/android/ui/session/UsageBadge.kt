package app.argus.android.ui.session

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.ui.theme.argusPalette
import app.argus.core.engine.ContextSnapshot
import app.argus.core.model.TokenUsage
import java.util.Locale

// Session-header token badge + context-window ring — the Android
// counterpart of the web's UsageBadge and a port of
// apps/ios/Argus/Sources/Views/UsageBadge.swift. The numbers come from
// :core (UsageMath / TranscriptEngine.contextSnapshot); this only paints.

/**
 * Session-header usage badge: the context ring (green < 60 %, amber
 * 60–85 %, red ≥ 85 % of the model's window) when the model is in the
 * window table, else the compact "↑ prompt ↓ output" totals; tap either
 * for the full breakdown. Renders nothing when there is neither.
 *
 * Header real estate is tight on a phone, so the badge is JUST the ring
 * — the ↑/↓ totals the web shows inline render only as the fallback tap
 * target when there is no ring, so the breakdown never becomes
 * unreachable (iOS parity).
 *
 * [onCompact] is the popover's "Compact session" action — the caller
 * gates it (claude-code only, idle only) and wires the /compact dispatch;
 * null hides the button.
 */
@Composable
fun UsageBadge(
    usage: TokenUsage?,
    context: ContextSnapshot?,
    onCompact: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val fraction = context?.fraction
    if (usage == null && fraction == null) return
    var showBreakdown by remember { mutableStateOf(false) }

    Box(modifier) {
        if (fraction != null) {
            ContextRing(
                fraction = fraction,
                modifier = Modifier
                    .clip(CircleShape)
                    .clickable { showBreakdown = true }
                    .padding(4.dp),
            )
        } else if (usage != null) {
            Text(
                "↑${TokenFormat.compact(promptTokens(usage))} ↓${TokenFormat.compact(usage.outputTokens)}",
                style = monoStyle(11.sp).copy(fontFeatureSettings = "tnum"),
                color = secondaryTextColor,
                maxLines = 1,
                modifier = Modifier
                    .clickable { showBreakdown = true }
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }
        DropdownMenu(expanded = showBreakdown, onDismissRequest = { showBreakdown = false }) {
            Breakdown(
                usage = usage,
                context = context,
                onCompact = onCompact?.let { action ->
                    {
                        showBreakdown = false
                        action()
                    }
                },
            )
        }
    }
}

/**
 * ↑ rolls in cache reads + writes since both are prompt-side tokens;
 * showing only `inputTokens` understates real usage by ~10x once caching
 * kicks in (claude-code, cursor). Codex reports everything under
 * inputTokens already, so this sum is a no-op there.
 */
private fun promptTokens(usage: TokenUsage): Double =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

/**
 * The donut. Sized to sit beside the toolbar's 20 dp glyphs so it reads
 * as a peer control; the arc grows clockwise from 12 o'clock — the
 * conventional "fullness" direction — over a faint track, and never
 * drops below a sliver so an empty ring is still visibly a ring.
 */
@Composable
fun ContextRing(fraction: Double, modifier: Modifier = Modifier, diameter: Dp = 20.dp) {
    val palette = argusPalette
    val tint = when {
        fraction >= 0.85 -> palette.statusFailed
        fraction >= 0.60 -> palette.statusRunning
        else -> palette.statusDone
    }
    val track = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f)
    val sweep = (360.0 * fraction.coerceIn(0.02, 1.0)).toFloat()
    Canvas(modifier = modifier.size(diameter)) {
        val strokeWidth = 3.dp.toPx()
        val inset = strokeWidth / 2f
        // `size` here is the DrawScope's — the composable's own is `diameter`.
        val arcSize = Size(size.width - strokeWidth, size.height - strokeWidth)
        drawArc(
            color = track,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = arcSize,
            style = Stroke(width = strokeWidth),
        )
        drawArc(
            color = tint,
            startAngle = -90f,
            sweepAngle = sweep,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = arcSize,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
    }
}

/**
 * Port of the web UsageBreakdown tooltip: the context block (family +
 * live percentage, a thin NEUTRAL bar — the ring is the threshold-
 * coloured element, the bar deliberately isn't — and full comma-grouped
 * `used / window` digits) above a divider; the cumulative session rows
 * below it, cache / cost / time rows only when > 0. Context rows sit
 * ABOVE the divider because they describe the latest turn's live state,
 * while everything below is cumulative across the session — distinct
 * semantics, worth the visual separation.
 */
@Composable
private fun Breakdown(usage: TokenUsage?, context: ContextSnapshot?, onCompact: (() -> Unit)?) {
    val mono = monoStyle(11.sp).copy(fontFeatureSettings = "tnum")
    Column(
        modifier = Modifier.widthIn(min = 220.dp).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val info = context?.windowInfo
        if (context != null && info != null) {
            val fraction = context.fraction ?: 0.0
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(info.family, style = captionStyle(), color = secondaryTextColor, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(12.dp))
                Text(String.format(Locale.getDefault(), "%.1f%%", fraction * 100), style = mono)
            }
            ContextBar(fraction = fraction.coerceIn(0.0, 1.0))
            Row(modifier = Modifier.fillMaxWidth()) {
                Text(TokenFormat.grouped(context.usedTokens.toDouble()), style = mono, color = tertiaryTextColor, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(12.dp))
                Text("/ ${TokenFormat.grouped(info.window.toDouble())}", style = mono, color = tertiaryTextColor)
            }
            if (usage != null) HorizontalDivider(modifier = Modifier.padding(vertical = 2.dp))
        }
        if (usage != null) {
            LabeledValue("Input", TokenFormat.grouped(usage.inputTokens), mono)
            LabeledValue("Output", TokenFormat.grouped(usage.outputTokens), mono)
            if (usage.cacheReadTokens > 0) LabeledValue("Cache read", TokenFormat.grouped(usage.cacheReadTokens), mono)
            if (usage.cacheWriteTokens > 0) LabeledValue("Cache write", TokenFormat.grouped(usage.cacheWriteTokens), mono)
            usage.costUsd?.takeIf { it > 0 }?.let { cost ->
                LabeledValue("Cost", String.format(Locale.getDefault(), "$%.4f", cost), mono)
            }
            usage.durationApiMs?.takeIf { it > 0 }?.let { ms ->
                LabeledValue("API time", TokenFormat.apiTime(ms), mono)
            }
        }
        if (onCompact != null) {
            OutlinedButton(onClick = onCompact, modifier = Modifier.fillMaxWidth().padding(top = 2.dp)) {
                Text("Compact session", style = captionStyle())
            }
        }
    }
}

/** The neutral utilisation bar under the family line. */
@Composable
private fun ContextBar(fraction: Double) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(4.dp)
            .clip(CircleShape)
            .background(argusPalette.surface2),
    ) {
        val filled = fraction.toFloat()
        if (filled > 0f) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(filled)
                    .height(4.dp)
                    .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)),
            )
        }
    }
}

@Composable
private fun LabeledValue(label: String, value: String, valueStyle: TextStyle) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = captionStyle(), color = secondaryTextColor, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(12.dp))
        Text(value, style = valueStyle)
    }
}

/** Number formatting shared by the badge and its breakdown (iOS `TokenFormat`). */
object TokenFormat {
    /**
     * Full comma-grouped digits (`301,119`) — the web tooltip's
     * `toLocaleString` form, so the grouping follows the device locale.
     */
    fun grouped(value: Double): String =
        String.format(Locale.getDefault(), "%,d", value.toLong())

    /** Port of the web `formatMs`: "980 ms", "45.3 s", "30m 28s". */
    fun apiTime(ms: Double): String {
        if (ms < 1000) return String.format(Locale.getDefault(), "%.0f ms", ms)
        val seconds = ms / 1000
        if (seconds < 60) return String.format(Locale.getDefault(), "%.1f s", seconds)
        val minutes = (seconds / 60).toInt()
        val rest = Math.round(seconds - minutes * 60.0).toInt()
        return "${minutes}m ${rest}s"
    }

    /**
     * `842` / `1.2k` / `48k` / `1.3M` — the badge's terse form. Delegates
     * to the activity capsule's [compactCount] so the thinking counter
     * and the badge can never disagree on rounding.
     */
    fun compact(value: Double): String =
        compactCount(value.toLong().coerceIn(0L, Int.MAX_VALUE.toLong()).toInt())
}
