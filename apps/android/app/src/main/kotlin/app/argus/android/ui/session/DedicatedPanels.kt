package app.argus.android.ui.session

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.ui.theme.argusPalette
import app.argus.core.engine.SubAgentCall
import app.argus.core.engine.TimelineItem
import app.argus.core.engine.TodoItem
import app.argus.core.engine.TodoStatus

// To-do + sub-agent panels — the Android counterparts of the web's
// TodoWindow / SubAgentWindow and a port of
// apps/ios/Argus/Sources/Views/DedicatedPanels.swift. Rendered per turn,
// above the answer (and above the expanded activity timeline). The rows
// come from :core (DedicatedPanels.extractTodos / extractSubAgents);
// these only paint.

/**
 * Collapsible to-do checklist (latest TodoWrite snapshot). Default open;
 * deliberately never auto-collapses when everything is done — the
 * finished plan stays visible next to the assistant's answer (web
 * parity). The open flag is saveable so the choice survives the row
 * leaving and re-entering the outer LazyColumn.
 */
@Composable
fun TodoWindow(todos: List<TodoItem>, modifier: Modifier = Modifier) {
    var open by rememberSaveable { mutableStateOf(true) }
    val done = todos.count { it.status == TodoStatus.COMPLETED }
    val allDone = todos.isNotEmpty() && done == todos.size

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(argusPalette.surface1.copy(alpha = 0.6f))
            .animateContentSize(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { open = !open }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = secondaryTextColor,
            )
            Text(text = "To-dos", style = captionStyle(), color = secondaryTextColor)
            Text(
                text = if (allDone) "${todos.size}" else "$done/${todos.size}",
                style = captionStyle().copy(fontSize = 11.sp, fontFeatureSettings = "tnum"),
                color = tertiaryTextColor,
            )
            Spacer(modifier = Modifier.weight(1f))
            Chevron(open = open)
        }

        if (open) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (todo in todos) {
                    key(todo.id) {
                        TodoRow(todo = todo)
                    }
                }
            }
        }
    }
}

@Composable
private fun TodoRow(todo: TodoItem) {
    val textColor = when (todo.status) {
        TodoStatus.COMPLETED -> tertiaryTextColor
        TodoStatus.IN_PROGRESS -> MaterialTheme.colorScheme.onSurface
        TodoStatus.PENDING -> secondaryTextColor
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            modifier = Modifier
                .padding(top = 1.dp)
                .size(14.dp),
            contentAlignment = Alignment.Center,
        ) {
            when (todo.status) {
                TodoStatus.COMPLETED -> Icon(
                    imageVector = Icons.Filled.CheckCircle,
                    contentDescription = null,
                    modifier = Modifier.size(13.dp),
                    // Web parity: emerald-500 at 80%, not bright system green.
                    tint = Color(0xFF10B981).copy(alpha = 0.8f),
                )
                TodoStatus.IN_PROGRESS -> CircularProgressIndicator(
                    modifier = Modifier.size(11.dp),
                    color = secondaryTextColor,
                    strokeWidth = 1.5.dp,
                )
                TodoStatus.PENDING -> Box(
                    modifier = Modifier
                        .size(11.dp)
                        .border(1.dp, tertiaryTextColor, CircleShape),
                )
            }
        }
        Text(
            text = todo.displayText,
            modifier = Modifier.weight(1f),
            style = captionStyle(),
            color = textColor,
            textDecoration = if (todo.status == TodoStatus.COMPLETED) {
                TextDecoration.LineThrough
            } else {
                TextDecoration.None
            },
        )
    }
}

/**
 * Collapsible list of sub-agent invocations. Window default open; each
 * row default-open only when it errored (web parity).
 */
@Composable
fun SubAgentWindow(calls: List<SubAgentCall>, modifier: Modifier = Modifier) {
    var open by rememberSaveable { mutableStateOf(true) }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(argusPalette.surface1.copy(alpha = 0.6f))
            .animateContentSize(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { open = !open }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.Person,
                contentDescription = null,
                modifier = Modifier.size(12.dp),
                tint = argusPalette.toolAmber,
            )
            Text(text = "Sub-agents", style = captionStyle(), color = secondaryTextColor)
            Text(
                text = "${calls.size}",
                style = captionStyle().copy(fontSize = 11.sp, fontFeatureSettings = "tnum"),
                color = tertiaryTextColor,
            )
            Spacer(modifier = Modifier.weight(1f))
            Chevron(open = open)
        }

        if (open) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (call in calls) {
                    key(call.id) {
                        SubAgentRow(call = call)
                    }
                }
            }
        }
    }
}

@Composable
private fun SubAgentRow(call: SubAgentCall) {
    // Initial state only: like the web's useState(isError) and the iOS
    // @State, a row that errors AFTER first draw does not pop itself open.
    var open by rememberSaveable(call.id) { mutableStateOf(call.isError) }
    // Nested tool cards keep their own open/closed map, keyed by item id,
    // exactly as the main timeline does.
    val nestedState = remember { mutableStateMapOf<String, Boolean>() }
    val hasBody = call.prompt.isNotEmpty() || call.result != null || call.nested.isNotEmpty()
    // The header badge counts tool calls only — the interleaved
    // Thought/Thinking items are prose, not activity units.
    val toolCount = call.nested.count { it.kind == TimelineItem.Kind.Tool }
    // An errored row is pinned open (iOS parity: the toggle is disabled).
    val toggleable = hasBody && !call.isError
    val palette = argusPalette

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .animateContentSize(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = toggleable) { open = !open }
                .padding(vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (call.subagentType.isNotEmpty()) {
                Text(
                    text = call.subagentType,
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(palette.surface2.copy(alpha = 0.6f))
                        .padding(horizontal = 5.dp, vertical = 1.dp),
                    style = monoStyle(10.sp),
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                )
            }
            val hasDescription = call.description.isNotEmpty()
            Box(modifier = Modifier.weight(1f)) {
                Text(
                    text = if (hasDescription) call.description else "no description",
                    style = captionStyle(),
                    fontStyle = if (hasDescription) FontStyle.Normal else FontStyle.Italic,
                    color = if (hasDescription) secondaryTextColor else tertiaryTextColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (toolCount > 0) {
                Text(
                    text = "$toolCount " + (if (toolCount == 1) "tool" else "tools"),
                    style = captionStyle().copy(fontSize = 10.sp, fontFeatureSettings = "tnum"),
                    color = tertiaryTextColor,
                    maxLines = 1,
                )
            }
            if (call.isError) {
                ErrorBadge()
            } else if (hasBody) {
                Chevron(open = open, size = 10.dp)
            }
        }

        if (open && hasBody) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (call.prompt.isNotEmpty()) {
                    SectionCaption(text = "prompt")
                    MonoBlock(text = call.prompt, maxHeight = 180.dp)
                }
                if (call.nested.isNotEmpty()) {
                    SectionCaption(text = "activity")
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(palette.surface2.copy(alpha = 0.4f))
                            .padding(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        // Chronological: tools interleaved with the
                        // sub-agent's streamed text and thinking.
                        for (item in call.nested) {
                            key(item.id) {
                                NestedRow(item = item, state = nestedState)
                            }
                        }
                    }
                }
                val result = call.result
                if (result != null) {
                    SectionCaption(text = if (call.isError) "error" else "result")
                    MonoBlock(text = result, isError = call.isError, maxHeight = 180.dp)
                }
            }
        }
    }
}

@Composable
private fun NestedRow(item: TimelineItem, state: SnapshotStateMap<String, Boolean>) {
    when (val kind = item.kind) {
        TimelineItem.Kind.Thought -> Text(
            text = item.text,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 2.dp),
            style = captionStyle().copy(fontSize = 11.sp),
            color = secondaryTextColor,
        )
        is TimelineItem.Kind.Thinking -> Text(
            text = if (kind.redacted) "[redacted thinking]" else item.text,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 2.dp),
            style = captionStyle().copy(fontSize = 11.sp),
            fontStyle = FontStyle.Italic,
            color = tertiaryTextColor,
        )
        else -> ToolPillCard(item = item, state = state)
    }
}
