package app.argus.android.ui.session

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.ui.components.DiffBlock
import app.argus.android.ui.components.ToolStyle
import app.argus.android.ui.theme.argusPalette
import app.argus.core.engine.TimelineItem
import app.argus.core.engine.ToolDisplay
import app.argus.core.engine.Turn
import app.argus.core.model.ISO8601
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

// The per-turn activity band — a collapsible capsule ("N tools · last
// tool · elapsed" with live dots while running) that expands into a
// left-railed timeline of tool cards, output, and thinking rows. The
// Android counterpart of the web's ActivityPill + ActivityPanel and a
// port of apps/ios/Argus/Sources/Views/ActivityViews.swift.
//
// Everything rendered here is derived in :core (TranscriptEngine builds
// the Turn; ToolDisplay phrases the tool rows); these composables only
// paint. They render inside an outer LazyColumn item, so they are plain
// Columns — no nested lazy lists.

/**
 * The tappable capsule ("N tools · last tool · elapsed"). Expansion state
 * is owned by the parent (the turn cell) so the expanded timeline can
 * render BELOW the to-do / sub-agent panels, matching the web order.
 *
 * Not self-gating: like iOS, the parent decides whether a turn earns a
 * capsule at all (`turn.timeline.isNotEmpty()`); a plain answer turn with
 * no activity should render none.
 */
@Composable
fun ActivityCapsule(
    turn: Turn,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val toolCount = turn.timeline.count { it.kind == TimelineItem.Kind.Tool }
    val palette = argusPalette
    val fg = if (expanded) MaterialTheme.colorScheme.onSurface else secondaryTextColor
    val caption = captionStyle().copy(fontFeatureSettings = "tnum")

    Row(
        modifier = modifier
            .clip(CircleShape)
            .background(palette.surface1.copy(alpha = if (expanded) 1f else 0.6f))
            .clickable(onClick = onToggle)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "$toolCount " + (if (toolCount == 1) "tool" else "tools"),
            style = caption,
            color = fg,
            maxLines = 1,
        )
        Separator()
        if (turn.isRunning) {
            RunningDots()
            // Live extended-thinking counter (the running max of the
            // sidecar's `thinking_tokens` progress chunks). Only while the
            // turn runs: once settled, the last tool is the better summary.
            val thinking = turn.thinkingTokens
            if (thinking != null && thinking > 0) {
                Separator()
                Text(
                    text = "${compactCount(thinking)} thinking",
                    style = caption,
                    color = tertiaryTextColor,
                    maxLines = 1,
                )
            }
        } else {
            Text(
                text = lastToolSummary(turn.timeline) ?: "done",
                modifier = Modifier.widthIn(max = 180.dp),
                style = monoStyle(12.sp),
                color = secondaryTextColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Separator()
        ElapsedLabel(turn = turn)
        Chevron(open = expanded, size = 12.dp, tint = fg)
    }
}

/**
 * The expanded left-railed timeline (interleaved thoughts + tool cards).
 * Per-row open/closed state (tool bodies, "show input", the compaction
 * summary) lives in one map keyed by item id — chunk ids, so it survives
 * the timeline growing under a live turn. It is plain `remember`, not
 * saveable: a row that scrolls out of the outer LazyColumn comes back
 * collapsed, which is the web's behaviour too.
 */
@Composable
fun ActivityTimeline(turn: Turn, modifier: Modifier = Modifier) {
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val rail = MaterialTheme.colorScheme.outlineVariant
    Column(
        modifier = modifier
            .fillMaxWidth()
            .drawBehind {
                drawLine(
                    color = rail,
                    start = Offset(0f, 0f),
                    end = Offset(0f, size.height),
                    strokeWidth = 1.dp.toPx(),
                )
            }
            .padding(start = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (item in turn.timeline) {
            key(item.id) {
                TimelineRow(item = item, state = expanded)
            }
        }
    }
}

// MARK: Capsule pieces

@Composable
private fun Separator() {
    Text(text = "·", style = captionStyle(), color = tertiaryTextColor)
}

/** Three pulsing dots while a turn streams (web's `Dot`). */
@Composable
private fun RunningDots() {
    val transition = rememberInfiniteTransition(label = "running-dots")
    val color = tertiaryTextColor
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        for (index in 0 until 3) {
            val alpha by transition.animateFloat(
                initialValue = 0.3f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 600, easing = FastOutSlowInEasing),
                    repeatMode = RepeatMode.Reverse,
                    initialStartOffset = StartOffset(index * 160),
                ),
                label = "dot$index",
            )
            Box(
                modifier = Modifier
                    .size(4.dp)
                    .alpha(alpha)
                    .background(color, CircleShape),
            )
        }
    }
}

/**
 * Elapsed wall-clock for the turn; ticks at 10 Hz while running so the
 * readout advances smoothly instead of jumping whenever a chunk arrives.
 * Once the turn settles, `completedAt` freezes the value and the ticker
 * is cancelled.
 */
@Composable
private fun ElapsedLabel(turn: Turn) {
    val createdAt = turn.command.createdAt
    val completedAt = turn.command.completedAt
    val startMs = remember(createdAt) { ISO8601.parseMillis(createdAt) }
    val endMs = remember(completedAt) { completedAt?.let { ISO8601.parseMillis(it) } }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(turn.isRunning) {
        if (!turn.isRunning) return@LaunchedEffect
        while (isActive) {
            now = System.currentTimeMillis()
            delay(100)
        }
    }
    val label = if (startMs == null) "" else formatElapsed(maxOf(0L, (endMs ?: now) - startMs))
    Text(
        text = label,
        style = captionStyle().copy(fontFeatureSettings = "tnum"),
        color = secondaryTextColor,
        maxLines = 1,
    )
}

/** `842ms`, `3.4s`, `2m 05s`-style elapsed readout (web `formatElapsed`). */
internal fun formatElapsed(ms: Long): String {
    if (ms < 1_000) return "${ms}ms"
    if (ms < 60_000) {
        val tenths = (ms + 50) / 100
        return "${tenths / 10}.${tenths % 10}s"
    }
    val total = ms / 1_000
    return "${total / 60}m ${total % 60}s"
}

/** `842`, `1.2k`, `48k`, `1.3M` — the thinking counter's compact form. */
internal fun compactCount(n: Int): String = when {
    n < 1_000 -> n.toString()
    n < 10_000 -> {
        val tenths = (n + 50) / 100
        "${tenths / 10}.${tenths % 10}k"
    }
    n < 1_000_000 -> "${(n + 500) / 1_000}k"
    else -> {
        val tenths = (n + 50_000) / 100_000
        "${tenths / 10}.${tenths % 10}M"
    }
}

/** "Read src/foo.kt" — the last tool row, one line, for the settled capsule. */
private fun lastToolSummary(timeline: List<TimelineItem>): String? {
    val last = timeline.lastOrNull { it.kind == TimelineItem.Kind.Tool } ?: return null
    val display = ToolDisplay.make(last.toolName, last.toolInput)
    val argument = display.argument ?: return display.verb
    return display.verb + " " + argument.replace('\n', ' ').trim()
}

// MARK: Timeline rows

/** One timeline row, dispatched by kind. */
@Composable
private fun TimelineRow(item: TimelineItem, state: SnapshotStateMap<String, Boolean>) {
    when (val kind = item.kind) {
        TimelineItem.Kind.Tool -> ToolPillCard(item = item, state = state)
        TimelineItem.Kind.Output -> OutputRow(text = item.text, isError = item.isError, isDiff = item.isDiff)
        TimelineItem.Kind.Thought -> {
            // Web parity: activity-panel thoughts are text-xs (12px),
            // smaller than the final answer body. Plain text here; the
            // markdown surface is the answer's.
            SelectionContainer {
                Text(
                    text = item.text,
                    modifier = Modifier.fillMaxWidth(),
                    style = captionStyle(),
                    color = secondaryTextColor,
                )
            }
        }
        is TimelineItem.Kind.Thinking -> ThinkingRow(text = item.text, redacted = kind.redacted)
        TimelineItem.Kind.Compact -> CompactDivider(label = item.text)
        TimelineItem.Kind.CompactSummary -> {
            val openKey = item.id + ":open"
            val open = state[openKey] ?: false
            CompactSummaryRow(text = item.text, open = open, onToggle = { state[openKey] = !open })
        }
        TimelineItem.Kind.System -> Text(
            text = item.text,
            modifier = Modifier.fillMaxWidth(),
            style = captionStyle(),
            fontStyle = FontStyle.Italic,
            color = secondaryTextColor,
        )
        TimelineItem.Kind.Error -> OutputRow(text = item.text, isError = true, isDiff = false)
    }
}

/**
 * Cursor-style tool card: icon + verb + argument, expandable to the tool
 * input JSON and its result (output or diff). Errors auto-expand.
 *
 * Shared with the sub-agent window's nested activity list, which is why
 * the open/closed state comes in as the caller's map (keyed by item id;
 * the "show input" toggle rides the same map under `<id>:input`) rather
 * than living here — both callers already own such a map.
 */
@Composable
internal fun ToolPillCard(item: TimelineItem, state: SnapshotStateMap<String, Boolean>) {
    val display = remember(item.toolName, item.toolInput) {
        ToolDisplay.make(item.toolName, item.toolInput)
    }
    val input: JsonObject? = item.toolInput?.takeIf { it.isNotEmpty() }
    val result = item.resultText
    val hasResult = !result.isNullOrEmpty()
    val expandable = input != null || hasResult
    // Errors open by default (web/iOS parity); the map only records
    // explicit user toggles, so an error that lands AFTER the row was
    // first drawn still opens itself — unlike a one-shot initial state.
    val showBody = state[item.id] ?: item.isError
    val inputKey = item.id + ":input"
    val showInput = state[inputKey] ?: false
    val palette = argusPalette

    Column(modifier = Modifier.fillMaxWidth().animateContentSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(6.dp))
                .background(if (showBody) palette.surface1.copy(alpha = 0.6f) else Color.Transparent)
                .clickable(enabled = expandable) { state[item.id] = !showBody }
                .padding(horizontal = 6.dp, vertical = 3.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = ToolStyle.icon(item.toolName),
                contentDescription = null,
                modifier = Modifier.size(13.dp),
                tint = ToolStyle.tint(item.toolName),
            )
            Text(
                text = display.verb,
                style = captionStyle(),
                color = secondaryTextColor,
                maxLines = 1,
            )
            val argument = display.argument
            if (argument != null) {
                // One line, trailing ellipsis (web parity): a long bash
                // command's tail must not read like a stray description
                // hanging past a mid-string "…". The Box takes the slack so
                // the trailing badge stays pinned to the edge.
                Box(modifier = Modifier.weight(1f)) {
                    Text(
                        text = argument.replace('\n', ' '),
                        style = if (display.mono) monoStyle(11.sp) else captionStyle(),
                        color = tertiaryTextColor,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            } else {
                Spacer(modifier = Modifier.weight(1f))
            }
            if (item.isError) {
                ErrorBadge()
            } else if (expandable) {
                Chevron(open = showBody, size = 10.dp)
            }
        }

        if (showBody) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 21.dp, top = 4.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (input != null) {
                    Text(
                        text = if (showInput) "HIDE INPUT" else "SHOW INPUT",
                        modifier = Modifier
                            .clickable { state[inputKey] = !showInput }
                            .padding(vertical = 2.dp),
                        style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.SemiBold),
                        color = tertiaryTextColor,
                    )
                    if (showInput) {
                        val pretty = remember(input) { prettyJson(input) }
                        MonoBlock(text = pretty, maxHeight = 200.dp)
                    }
                }
                if (item.isDiff) {
                    DiffBlock(diff = item.diffBody, maxHeight = 220.dp)
                } else if (result != null && result.isNotEmpty()) {
                    MonoBlock(text = result, isError = item.isError, maxHeight = 200.dp)
                }
            }
        }
    }
}

private val PrettyJson: Json = Json { prettyPrint = true }

/** The tool input as indented JSON for the "show input" block. */
private fun prettyJson(input: JsonObject): String =
    runCatching { PrettyJson.encodeToString(JsonObject.serializer(), input) }
        .getOrDefault(input.toString())

@Composable
private fun OutputRow(text: String, isError: Boolean, isDiff: Boolean) {
    if (isDiff) {
        DiffBlock(diff = text, maxHeight = 220.dp)
    } else {
        MonoBlock(text = text, isError = isError, maxHeight = 200.dp)
    }
}

@Composable
private fun ThinkingRow(text: String, redacted: Boolean) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        SectionCaption(text = "thinking")
        if (redacted) {
            Text(
                text = "[redacted]",
                style = captionStyle().copy(fontSize = 11.sp),
                fontStyle = FontStyle.Italic,
                color = tertiaryTextColor,
            )
        } else {
            SelectionContainer {
                Text(
                    text = text,
                    modifier = Modifier.fillMaxWidth(),
                    style = captionStyle(),
                    color = secondaryTextColor,
                )
            }
        }
    }
}

/**
 * Compaction divider — everything above was replaced by a summary.
 * Mirrors the web's centered-rule row.
 */
@Composable
private fun CompactDivider(label: String) {
    val rule = secondaryTextColor.copy(alpha = 0.25f)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HorizontalDivider(modifier = Modifier.weight(1f), color = rule)
        Text(
            text = label.uppercase(),
            style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Medium),
            color = tertiaryTextColor,
            maxLines = 1,
        )
        HorizontalDivider(modifier = Modifier.weight(1f), color = rule)
    }
}

/**
 * The injected compaction summary — collapsed by default (long,
 * semi-internal CLI copy); what future turns actually know about the
 * compacted past.
 */
@Composable
private fun CompactSummaryRow(text: String, open: Boolean, onToggle: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp)
            .animateContentSize(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier
                .clickable(onClick = onToggle)
                .padding(vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SectionCaption(text = "compaction summary")
            Chevron(open = open, size = 10.dp)
        }
        if (open) {
            SelectionContainer {
                Text(
                    text = text,
                    modifier = Modifier.fillMaxWidth(),
                    style = captionStyle(),
                    color = secondaryTextColor,
                )
            }
        }
    }
}

// MARK: Shared atoms (also used by DedicatedPanels.kt)

/** Secondary label colour — SwiftUI's `.secondary`. */
internal val secondaryTextColor: Color
    @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant

/** Tertiary label colour — SwiftUI's `.tertiary`. */
internal val tertiaryTextColor: Color
    @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.65f)

/** 12 sp body — SwiftUI's `.caption`, the web's text-xs. */
@Composable
internal fun captionStyle(): TextStyle = MaterialTheme.typography.bodySmall

/** Monospace at [size] (11 sp = SwiftUI `.caption2.monospaced()`). */
internal fun monoStyle(size: TextUnit = 11.sp): TextStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = size,
    lineHeight = size * 1.45f,
)

/** Flip-down chevron; 180° rotated when [open] so the flip animates. */
@Composable
internal fun Chevron(
    open: Boolean,
    modifier: Modifier = Modifier,
    size: Dp = 12.dp,
    tint: Color = tertiaryTextColor,
) {
    val angle by animateFloatAsState(targetValue = if (open) 180f else 0f, label = "chevron")
    Icon(
        imageVector = Icons.Filled.KeyboardArrowDown,
        contentDescription = null,
        modifier = modifier.size(size).rotate(angle),
        tint = tint,
    )
}

/** Uppercase 10 sp section label ("prompt", "result", "thinking"). */
@Composable
internal fun SectionCaption(text: String) {
    Text(
        text = text.uppercase(),
        style = TextStyle(fontSize = 10.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.4.sp),
        color = tertiaryTextColor,
        maxLines = 1,
    )
}

/** The small red "ERROR" trailing badge on a failed tool / sub-agent row. */
@Composable
internal fun ErrorBadge() {
    Text(
        text = "ERROR",
        style = TextStyle(fontSize = 9.sp, fontWeight = FontWeight.SemiBold),
        color = argusPalette.statusFailed,
        maxLines = 1,
    )
}

/**
 * Scrollable monospace block on a layered surface (tool output / input /
 * sub-agent prompt). Wraps long lines like the iOS `MonoBlock`; a diff
 * goes through [DiffBlock] instead, which scrolls sideways.
 */
@Composable
internal fun MonoBlock(
    text: String,
    modifier: Modifier = Modifier,
    isError: Boolean = false,
    maxHeight: Dp = 200.dp,
) {
    val color = if (isError) argusPalette.statusFailed else secondaryTextColor
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(argusPalette.surface1.copy(alpha = 0.5f))
            .heightIn(max = maxHeight)
            .verticalScroll(rememberScrollState())
            .padding(8.dp),
    ) {
        SelectionContainer {
            Text(
                text = text,
                modifier = Modifier.fillMaxWidth(),
                style = monoStyle(11.sp),
                color = color,
            )
        }
    }
}
