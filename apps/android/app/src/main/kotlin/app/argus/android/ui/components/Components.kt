package app.argus.android.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.AppModel
import app.argus.android.R
import app.argus.android.CloneFailure
import app.argus.android.ui.theme.argusPalette
import app.argus.core.model.AgentType
import app.argus.core.model.KnownAgentType
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionStatus
import kotlinx.coroutines.delay

// Shared UI atoms — the Android counterpart of Components.swift: the
// agent brand colours and the amber/emerald/red status-dot grammar from
// the web sidebar.

/** A filled circle — status dots, the login mark. */
@Composable
fun StatusCircle(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.background(color, CircleShape))
}

@Composable
fun agentColor(type: AgentType): Color = when (type) {
    KnownAgentType.CLAUDE_CODE -> argusPalette.agentClaude
    KnownAgentType.CODEX -> argusPalette.agentCodex
    KnownAgentType.CURSOR_CLI -> argusPalette.agentCursor
    else -> argusPalette.agentCustom
}

/**
 * The per-CLI glyph — the same brand marks the web (`@lobehub/icons`)
 * and iOS (`Assets.xcassets/agent-*`) ship, copied from the iOS
 * catalog into density drawables (`res/drawable-*dpi/agent_*.png`,
 * 24dp at 1x/2x/3x). Two of them are theme-resolved exactly as the web's
 * `AgentTypeIcon.tsx` does: Codex's brand glyph is a black mark on a
 * white tile that reads right on the light page but pops as a bright
 * chip on the dark surface, so dark mode draws the mono glyph tinted
 * with the text colour instead; Cursor's mark is mono and tinted in both
 * themes. Claude's mark paints its own colour and is never tinted. An
 * unknown CLI type keeps a neutral monogram so the row still has a
 * leading mark.
 */
@Composable
fun AgentTypeGlyph(type: AgentType, modifier: Modifier = Modifier, size: Int = 18) {
    val dark = argusPalette.isDark
    val sized = modifier.size(size.dp)
    when (type) {
        KnownAgentType.CLAUDE_CODE -> Image(
            painter = painterResource(R.drawable.agent_claude_code),
            contentDescription = "Claude Code",
            modifier = sized,
        )
        KnownAgentType.CODEX -> if (dark) {
            Icon(
                painter = painterResource(R.drawable.agent_codex),
                contentDescription = "Codex",
                tint = MaterialTheme.colorScheme.onSurface,
                modifier = sized,
            )
        } else {
            Image(
                painter = painterResource(R.drawable.agent_codex_brand),
                contentDescription = "Codex",
                modifier = sized,
            )
        }
        KnownAgentType.CURSOR_CLI -> Icon(
            painter = painterResource(R.drawable.agent_cursor_cli),
            contentDescription = "Cursor CLI",
            tint = MaterialTheme.colorScheme.onSurface,
            modifier = sized,
        )
        else -> Box(
            modifier = sized.background(argusPalette.agentCustom.copy(alpha = 0.9f), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "•",
                color = Color.White,
                fontSize = (size * 0.58f).sp,
                fontWeight = FontWeight.Bold,
                lineHeight = (size * 0.6f).sp,
            )
        }
    }
}

/**
 * Sidebar status grammar (mirrors the web): amber = running, emerald =
 * done + unread, red = failed + unread, nothing otherwise.
 */
@Composable
fun SessionStatusDot(session: SessionDTO, modifier: Modifier = Modifier) {
    val palette = argusPalette
    val color: Color? = when {
        session.status == SessionStatus.ACTIVE -> palette.statusRunning
        !session.unread -> null
        session.status == SessionStatus.FAILED -> palette.statusFailed
        session.status == SessionStatus.IDLE -> palette.statusDone
        else -> null
    }
    if (color != null) StatusCircle(color, modifier.size(8.dp)) else Spacer(modifier.size(8.dp))
}

/**
 * Thin "reconnecting" strip shown while the socket is down but the app
 * believes it is logged in.
 */
@Composable
fun ConnectionBanner(app: AppModel, modifier: Modifier = Modifier) {
    val connected by app.socketConnected.collectAsState()
    if (connected) return
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(argusPalette.toolAmber.copy(alpha = 0.15f))
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 1.5.dp)
        Spacer(Modifier.width(6.dp))
        Text(
            "Reconnecting…",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * Bottom toast column for failed session-clone-from-turn events — the
 * web SessionCloneFailedToasts: amber warning card per session, newest
 * on top, auto-dismissed after 8 s (the copy isn't actionable beyond
 * "next prompt starts fresh", so sticky would just be visual debt).
 */
@Composable
fun CloneFailureToasts(app: AppModel, modifier: Modifier = Modifier) {
    val failures by app.cloneFailures.collectAsState()
    if (failures.isEmpty()) return
    Column(
        modifier = modifier.widthIn(max = 420.dp).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (failure in failures.sortedByDescending { it.startedAt }) {
            CloneFailureCard(failure) { app.dismissCloneFailure(failure.sessionId) }
        }
    }
}

@Composable
private fun CloneFailureCard(failure: CloneFailure, onDismiss: () -> Unit) {
    // The id carries startedAt, so a re-failure restarts the timer.
    LaunchedEffect(failure.id) {
        delay(8_000)
        onDismiss()
    }
    val palette = argusPalette
    Surface(
        color = palette.surface1,
        shape = RoundedCornerShape(10.dp),
        tonalElevation = 2.dp,
        shadowElevation = 4.dp,
    ) {
        Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            Icon(Icons.Default.Warning, contentDescription = null, tint = palette.toolAmber, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        failure.sessionTitle,
                        style = MaterialTheme.typography.labelMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Text("clone failed", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    "Couldn't fork CLI state. Next prompt will start a fresh conversation.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (failure.reason.isNotEmpty()) {
                    Text(
                        failure.reason,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            IconButton(onClick = onDismiss, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Default.Close, contentDescription = "Dismiss", modifier = Modifier.size(14.dp))
            }
        }
    }
}
