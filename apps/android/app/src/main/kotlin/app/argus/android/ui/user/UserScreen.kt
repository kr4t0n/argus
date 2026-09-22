@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.user

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.AppModel
import app.argus.android.ui.components.AgentTypeGlyph
import app.argus.android.ui.components.ConnectionBanner
import app.argus.android.ui.session.TokenFormat
import app.argus.android.ui.session.captionStyle
import app.argus.android.ui.session.monoStyle
import app.argus.android.ui.session.secondaryTextColor
import app.argus.android.ui.session.tertiaryTextColor
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.engine.RelativeTime
import app.argus.core.model.ActivityDay
import app.argus.core.model.AgentType
import app.argus.core.model.ISO8601
import app.argus.core.model.KnownAgentType
import app.argus.core.model.QuotaWindow
import app.argus.core.model.TokenUsage
import app.argus.core.model.UserExtensions
import app.argus.core.model.UserQuotaRow
import app.argus.core.model.WindowedUsage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import java.time.LocalDate
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

// The account screen — the Android counterpart of the web's /user page and
// a port of apps/ios/Argus/Sources/Views/UserPanelView.swift: identity +
// sign out, the activity heatmap / curve, the token-usage ledger with
// rolling windows, per-CLI plan quota, the (not yet live) alert toggle,
// and the extension opt-ins. Everything on the page is a read of three
// /me/* payloads plus AppModel.extensions; the charts are plain Canvas
// drawing, no charting dependency (same posture as the web's pure-SVG
// components — iOS uses Swift Charts because it ships with the OS).

/**
 * Renders the account panel inside a [Scaffold] with an "Account" top bar
 * (back arrow when [showBack], a Refresh action always).
 *
 * **Loading is per section.** Usage, quota and activity are fetched
 * concurrently on open (a `supervisorScope`, so one failure cannot cancel
 * its siblings) and each section settles on its own: a failed one shows a
 * one-line error while the others render. The web does the same with three
 * independent effects; iOS collapses the three into one `loadError`, which
 * blanks a healthy section because an unrelated one 500'd. Refresh
 * re-fetches all three; a section that already has data keeps it until the
 * fresh payload lands (no flash back to a spinner), a failed one retries
 * from the spinner.
 */
@Composable
fun UserScreen(app: AppModel, onBack: () -> Unit, showBack: Boolean = true) {
    val user by app.user.collectAsState()
    val extensions by app.extensions.collectAsState()

    var usage by remember { mutableStateOf<Load<WindowedUsage>>(Load.Loading) }
    var quotas by remember { mutableStateOf<Load<List<UserQuotaRow>>>(Load.Loading) }
    var activity by remember { mutableStateOf<Load<List<ActivityDay>>>(Load.Loading) }
    var refreshKey by remember { mutableIntStateOf(0) }

    LaunchedEffect(refreshKey) {
        val client = app.client ?: return@LaunchedEffect
        if (usage is Load.Failed) usage = Load.Loading
        if (quotas is Load.Failed) quotas = Load.Loading
        if (activity is Load.Failed) activity = Load.Loading
        // One child per section rather than three `async`s awaited in a
        // row: a sequential await would hold the quota and activity
        // assignments behind the slowest request, and the point is that
        // each section paints the moment its own payload arrives.
        supervisorScope {
            launch { usage = settle(app::handleApiError) { client.getMyUsage() } }
            launch { quotas = settle(app::handleApiError) { client.getMyQuota() } }
            launch { activity = settle(app::handleApiError) { client.getMyActivity() } }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Account") },
                navigationIcon = {
                    if (showBack) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { refreshKey++ }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(Modifier.padding(innerPadding).fillMaxSize()) {
            ConnectionBanner(app)
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // A settings column reads badly at full tablet width; the
                // web caps its page at max-w-6xl for the same reason.
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .widthIn(max = 720.dp)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(24.dp),
                ) {
                    AccountBand(email = user?.email, role = user?.role, onSignOut = { app.logOut() })
                    ActivitySection(activity)
                    UsageSection(usage)
                    QuotaSection(quotas)
                    NotificationsSection()
                    ExtensionsSection(
                        extensions = extensions,
                        onChange = { next ->
                            // Launched on the process scope, not this
                            // screen's: a PUT the user fires on the way
                            // out must still land, and setExtensions'
                            // catch-and-revert would otherwise read the
                            // cancellation as a failure and undo a write
                            // the server had already applied.
                            app.scope.launch { app.setExtensions(next) }
                        },
                    )
                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

// MARK: Loading

/** One section's fetch state; each of the three settles independently. */
private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Ready<T>(val value: T) : Load<T>
    data class Failed(val message: String) : Load<Nothing>
}

/**
 * Run one request and fold the outcome into a [Load]. Cancellation is
 * re-thrown, never recorded: when the screen leaves mid-fetch the
 * coroutine is cancelled, and a swallowed `CancellationException` would
 * paint that as a server error on the next visit.
 */
private suspend fun <T> settle(onError: (Throwable) -> Unit, request: suspend () -> T): Load<T> =
    try {
        Load.Ready(request())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        onError(e)
        Load.Failed((e as? ApiError)?.message ?: e.message ?: "request failed")
    }

@Composable
private fun LoadingRow() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 1.5.dp)
        Spacer(Modifier.width(8.dp))
        Text("loading…", style = captionStyle(), color = tertiaryTextColor)
    }
}

@Composable
private fun ErrorLine(message: String) {
    Text(message, style = captionStyle(), color = argusPalette.statusFailed)
}

@Composable
private fun EmptyHint(text: String) {
    Text(text, style = captionStyle(), color = secondaryTextColor)
}

// MARK: Sections

/**
 * An inset-grouped section — the iOS `List` section shape: a small
 * uppercase header, a card on `surface1`, an optional footer caption.
 */
@Composable
private fun Section(title: String, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = secondaryTextColor,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
        Surface(color = argusPalette.surface1, shape = RoundedCornerShape(12.dp)) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                content = content,
            )
        }
        if (footer != null) {
            Text(footer, style = captionStyle(), color = tertiaryTextColor, modifier = Modifier.padding(horizontal = 4.dp))
        }
    }
}

/**
 * Identity plus the one action on the page that ends the session.
 *
 * Sign out has deliberately NO confirmation (web `SignOutAction`): a
 * confirm belongs on the irreversible — deleting a machine — and this
 * costs a re-login and nothing else. Putting a confirm on a reversible
 * action is friction that mainly teaches people to click through
 * confirms. The red marks weight, not danger: it is the one control
 * here that does not adjust a setting. The avatar is a monogram, like the
 * agent glyphs elsewhere in the app (no vendored icon set).
 */
@Composable
private fun AccountBand(email: String?, role: String?, onSignOut: () -> Unit) {
    Surface(color = argusPalette.surface1, shape = RoundedCornerShape(12.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier.size(40.dp).background(argusPalette.surface2, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    email?.firstOrNull()?.uppercaseChar()?.toString() ?: "?",
                    style = MaterialTheme.typography.titleMedium,
                    color = secondaryTextColor,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    email ?: "—",
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!role.isNullOrEmpty()) {
                    Text(role, style = captionStyle(), color = secondaryTextColor)
                }
            }
            Spacer(Modifier.width(12.dp))
            TextButton(
                onClick = onSignOut,
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) {
                Text("Sign out")
            }
        }
    }
}

private enum class ActivityMode(val label: String) { GRID("Grid"), CURVE("Curve") }

/**
 * Grid / Curve over ONE `/me/activity` payload — a pure client-side view
 * swap, no refetch (web parity). Defaults to the grid, the reading the
 * page always had.
 */
@Composable
private fun ActivitySection(load: Load<List<ActivityDay>>) {
    var mode by remember { mutableStateOf(ActivityMode.GRID) }
    Section(title = "Activity") {
        when (load) {
            Load.Loading -> LoadingRow()
            is Load.Failed -> ErrorLine(load.message)
            is Load.Ready -> {
                val days = load.value
                if (days.isEmpty()) {
                    EmptyHint("No activity yet.")
                } else {
                    SegmentedToggle(
                        options = ActivityMode.entries,
                        selected = mode,
                        label = { it.label },
                        onSelect = { mode = it },
                    )
                    when (mode) {
                        ActivityMode.GRID -> ActivityHeatmap(days)
                        ActivityMode.CURVE -> ActivityCurve(days)
                    }
                }
            }
        }
    }
}

private enum class UsageWindow(val label: String) { WEEK("7 days"), MONTH("30 days"), LIFETIME("All time") }

/**
 * One payload, three windows: the toggle selects which slice of
 * `WindowedUsage` the ledger renders — no refetch. Defaults to 30 days
 * because that is the actionable "what am I spending lately" view; "All
 * time" keeps the lifetime headline for anyone who wants it (web
 * `UsageSection`).
 */
@Composable
private fun UsageSection(load: Load<WindowedUsage>) {
    var window by remember { mutableStateOf(UsageWindow.MONTH) }
    Section(title = "Usage") {
        when (load) {
            Load.Loading -> LoadingRow()
            is Load.Failed -> ErrorLine(load.message)
            is Load.Ready -> {
                SegmentedToggle(
                    options = UsageWindow.entries,
                    selected = window,
                    label = { it.label },
                    onSelect = { window = it },
                )
                val current = when (window) {
                    UsageWindow.WEEK -> load.value.last7Days
                    UsageWindow.MONTH -> load.value.last30Days
                    UsageWindow.LIFETIME -> load.value.lifetime
                }
                if (current.hasUsage) {
                    UsageLedger(current)
                } else {
                    EmptyHint(
                        when (window) {
                            UsageWindow.WEEK -> "No usage in the last 7 days."
                            UsageWindow.MONTH -> "No usage in the last 30 days."
                            UsageWindow.LIFETIME -> "No completed turns yet. Usage appears once an agent finishes a prompt."
                        },
                    )
                }
            }
        }
    }
}

/**
 * The stat grid, two per row (the iOS `LazyVGrid`). "Prompt" rolls cache
 * reads and writes into the input figure — the same reasoning as the
 * session badge's ↑ total: once caching kicks in, `inputTokens` alone
 * understates the prompt side by ~10x on claude-code and cursor. The
 * cache lines stay listed separately so the split is still visible. Cost
 * and API time render only when the adapter reported them (codex has no
 * notional cost); a window with a real cost of $0 still shows "$0.00".
 */
@Composable
private fun UsageLedger(usage: TokenUsage) {
    val entries = buildList<Pair<String, String>> {
        add("Prompt" to ledgerTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens))
        add("Output" to ledgerTokens(usage.outputTokens))
        add("Cache read" to ledgerTokens(usage.cacheReadTokens))
        add("Cache write" to ledgerTokens(usage.cacheWriteTokens))
        // Locale.ROOT: lint's NonObservableLocale rejects a default-locale
        // read inside a composable, and a dollar figure needs no grouping.
        usage.costUsd?.let { add("Cost" to String.format(Locale.ROOT, "$%.2f", it)) }
        usage.durationApiMs?.let { add("API time" to TokenFormat.apiTime(it)) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (pair in entries.chunked(2)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for ((label, value) in pair) {
                    Stat(label = label, value = value, modifier = Modifier.weight(1f))
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            value,
            style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum"),
            maxLines = 1,
        )
        Text(label, style = captionStyle(), color = secondaryTextColor)
    }
}

/**
 * `TokenFormat.compact` for the badge's range, then B / T above it: the
 * lifetime cache-read total of a heavy user can pass two billion tokens,
 * where `compact`'s Int clamp would print a wrong number rather than a
 * large one (the web ledger formats k / M / B / T for the same reason).
 */
private fun ledgerTokens(value: Double): String = when {
    value >= 1e12 -> String.format(Locale.ROOT, "%.1fT", value / 1e12)
    value >= 1e9 -> String.format(Locale.ROOT, "%.1fB", value / 1e9)
    else -> TokenFormat.compact(value)
}

/**
 * One card per `(cliType, machine)` quota row. Empty is a real state, not
 * an error: rows only exist once a sidecar has read the CLI's OAuth file
 * and piggy-backed the vendor's usage endpoint onto a heartbeat.
 */
@Composable
private fun QuotaSection(load: Load<List<UserQuotaRow>>) {
    Section(title = "Plan quota") {
        when (load) {
            Load.Loading -> LoadingRow()
            is Load.Failed -> ErrorLine(load.message)
            is Load.Ready -> {
                val rows = load.value
                if (rows.isEmpty()) {
                    EmptyHint("No quota data yet — sidecars report it with their heartbeat.")
                } else {
                    rows.forEachIndexed { index, row ->
                        if (index > 0) HorizontalDivider()
                        QuotaRowView(row)
                    }
                }
            }
        }
    }
}

/**
 * Glyph + CLI, the machine it was probed on, the probe source, then one
 * bar per plan window. A row whose probe failed (`error` set, no windows)
 * shows the error instead of bars — rendered, not hidden, so a broken
 * credential file is visible from the fleet rather than silently absent.
 * The reset time sits inline after the label: the web keeps it in a
 * tooltip, but there is no hover on a phone.
 */
@Composable
private fun QuotaRowView(row: UserQuotaRow) {
    val now = System.currentTimeMillis()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AgentTypeGlyph(row.type, size = 18)
            Text(agentLabel(row.type), style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.weight(1f))
            if (row.machineName.isNotEmpty()) {
                Text(
                    row.machineName,
                    style = captionStyle(),
                    color = tertiaryTextColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        val meta = listOfNotNull(
            row.source.takeIf { it.isNotEmpty() },
            checkedLabel(row.checkedAt, now),
        ).joinToString(" · ")
        if (meta.isNotEmpty()) {
            Text(meta, style = captionStyle(), color = tertiaryTextColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val error = row.error
        if (error != null && row.windows.isEmpty()) {
            Text("Couldn't read quota: $error", style = captionStyle(), color = argusPalette.toolAmber)
        }
        for (window in row.windows) {
            QuotaBar(window, now)
        }
    }
}

/**
 * One plan window as a labelled bar. Colour is how close the window is to
 * running out — the same 60 % / 85 % thresholds as Anthropic's own
 * `/status` display (and the context ring): under 60 reads as "fine",
 * 60–85 as "be aware", over 85 as "you might hit the wall this window".
 */
@Composable
private fun QuotaBar(window: QuotaWindow, now: Long) {
    val used = window.utilizationPercent.coerceIn(0.0, 100.0)
    val palette = argusPalette
    val tint = when {
        used >= 85 -> palette.statusFailed
        used >= 60 -> palette.statusRunning
        else -> palette.statusDone
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(window.label.ifEmpty { window.key }, style = captionStyle(), color = secondaryTextColor)
            window.resetsAt?.let { resetsAt ->
                Text(
                    " · resets ${formatResetAt(resetsAt, now)}",
                    style = captionStyle(),
                    color = tertiaryTextColor,
                    maxLines = 1,
                )
            }
            Spacer(Modifier.weight(1f))
            Text(
                "${used.roundToInt()}%",
                style = monoStyle(11.sp).copy(fontFeatureSettings = "tnum"),
                color = secondaryTextColor,
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(CircleShape)
                .background(palette.surface2),
        ) {
            if (used > 0) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth((used / 100.0).toFloat())
                        .fillMaxHeight()
                        .background(tint),
                )
            }
        }
    }
}

/**
 * Push arrives in a later phase (FCM, with the server's transport split),
 * so the alert toggle is rendered DISABLED rather than faked: a switch
 * that flips and persists nothing would teach the user it works.
 */
@Composable
private fun NotificationsSection() {
    Section(
        title = "Notifications",
        footer = "A push arrives when a turn finishes in a session you're not looking at.",
    ) {
        ToggleRow(
            title = "Task completion alerts",
            subtitle = "Arrives with push notifications",
            checked = false,
            enabled = false,
            onCheckedChange = null,
        )
    }
}

/**
 * Account-level opt-ins, read from `AppModel.extensions` (the inspector
 * gates its Note / Diff tabs on the same flow). Each change PUTs the FULL
 * flag set built from the current value — the server has no merge
 * semantics, so every other extension's state is forwarded alongside the
 * one that changed (web parity). The optimistic flip and the revert on
 * failure live in `AppModel.setExtensions`.
 */
@Composable
private fun ExtensionsSection(extensions: UserExtensions, onChange: (UserExtensions) -> Unit) {
    Section(
        title = "Extensions",
        footer = "Account-level opt-ins, synced with the web dashboard. Each enabled extension adds its tab to the session inspector.",
    ) {
        ToggleRow(
            title = "Notes",
            subtitle = "A per-project scratchpad; every session in the same working directory shares it",
            checked = extensions.notes,
            onCheckedChange = { onChange(extensions.copy(notes = it)) },
        )
        ToggleRow(
            title = "Diff",
            subtitle = "Every file the agent changed in the most recent turn, as a per-file diff",
            checked = extensions.diff,
            onCheckedChange = { onChange(extensions.copy(diff = it)) },
        )
    }
}

@Composable
private fun ToggleRow(
    title: String,
    subtitle: String?,
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    enabled: Boolean = true,
) {
    val interactive = enabled && onCheckedChange != null
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (interactive) Modifier.clickable { onCheckedChange?.invoke(!checked) } else Modifier),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.5f),
            )
            if (!subtitle.isNullOrEmpty()) {
                Text(subtitle, style = captionStyle(), color = secondaryTextColor)
            }
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

/**
 * The iOS segmented picker: one selected option out of a short list. The
 * M3 check-mark icon is suppressed — three labelled segments inside the
 * card's padding are ~99 dp each on a 360 dp phone, and the icon's 26 dp
 * would ellipsize "30 days"; the filled segment already marks selection,
 * as it does on iOS and the web.
 */
@Composable
private fun <T> SegmentedToggle(
    options: List<T>,
    selected: T,
    label: (T) -> String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    SingleChoiceSegmentedButtonRow(modifier = modifier) {
        options.forEachIndexed { index, option ->
            SegmentedButton(
                selected = option == selected,
                onClick = { onSelect(option) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                icon = {},
                label = { Text(label(option), style = MaterialTheme.typography.labelMedium, maxLines = 1) },
            )
        }
    }
}

// MARK: Activity heatmap

/** Data allows up to a year of columns; the width decides how many show. */
private const val HEATMAP_MAX_WEEKS = 52

/** Gap as a fraction of cell size — scales with the fill. */
private const val HEATMAP_GAP_RATIO = 0.22f

/**
 * Min column gap between two month labels: the calendar can put two month
 * transitions within a column or two of each other (a month starting
 * mid-week), and labels that close collide.
 */
private const val MIN_MONTH_LABEL_GAP_COLS = 3

/** Same container height as the curve, so the toggle never reflows the page. */
private val CHART_HEIGHT = 150.dp

/** Web bucket palette: emerald-200/400/500/600 on light, 900/700/500/300 on dark. */
private val HEATMAP_LIGHT = listOf(Color(0xFFA7F3D0), Color(0xFF34D399), Color(0xFF10B981), Color(0xFF059669))
private val HEATMAP_DARK = listOf(Color(0xFF064E3B), Color(0xFF047857), Color(0xFF10B981), Color(0xFF6EE7B7))

/** The curve's line: emerald-500 on light, emerald-400 on dark (web `LIGHT` / `DARK`). */
private val CURVE_LIGHT = Color(0xFF10B981)
private val CURVE_DARK = Color(0xFF34D399)

/**
 * GitHub-style contribution grid: 7 rows (Sunday first, as on github.com
 * and the web), one column per week, drawn in a Canvas.
 *
 * **Cells size to fill** (iOS / web parity — no fixed-size cells leaving
 * blank space): the cell comes from the fixed HEIGHT, and the WIDTH
 * decides how many trailing weeks show — as many as fill it edge to edge,
 * then re-derived from the width so the fill is exact (cells end up a hair
 * smaller, never taller). With less history than fills the width, cells
 * stay height-sized and the grid centres.
 *
 * **Colour is bucketed by quantile, not scaled by the peak.** Thresholds
 * come from the user's own non-zero days (25 / 50 / 75 %), so each active
 * shade holds about a quarter of their active days whether they run 2 or
 * 200 commands a day — GitHub does the same. Scaling by the peak (the iOS
 * draw) lets one outlier day flatten every other cell to the palest shade.
 *
 * **Month labels along the top.** There is no hover on a phone, so the
 * labels are the only calendar anchor the grid has; a label that would
 * collide with the previous one, or run past the right edge, is skipped.
 */
@Composable
private fun ActivityHeatmap(days: List<ActivityDay>) {
    val grid = remember(days) { buildHeatmapGrid(days) }
    val total = remember(days) { days.sumOf { it.count } }
    val palette = argusPalette
    val buckets = remember(palette.isDark) {
        listOf(palette.surface2) + (if (palette.isDark) HEATMAP_DARK else HEATMAP_LIGHT)
    }
    val textMeasurer = rememberTextMeasurer()
    val labelStyle = captionStyle().copy(fontSize = 10.sp, color = tertiaryTextColor)

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "${TokenFormat.grouped(total.toDouble())} command${if (total == 1) "" else "s"} in the last year",
            style = captionStyle(),
            color = secondaryTextColor,
        )
        Canvas(modifier = Modifier.fillMaxWidth().height(CHART_HEIGHT)) {
            val labelH = 14.dp.toPx()
            val gridArea = size.height - labelH
            val cellFromHeight = gridArea / (7 + 6 * HEATMAP_GAP_RATIO)
            val columnBudget = (size.width + cellFromHeight * HEATMAP_GAP_RATIO) /
                (cellFromHeight * (1 + HEATMAP_GAP_RATIO))
            val wanted = max(1, ceil(columnBudget).toInt())
            val shown = grid.columns.takeLast(wanted)
            val firstShown = grid.columns.size - shown.size
            val columns = max(1, shown.size).toFloat()
            val cell = if (shown.size < wanted) {
                // Not enough history to fill — keep height-sized cells.
                cellFromHeight
            } else {
                // Enough columns: stretch to fill the width exactly.
                size.width / (columns + (columns - 1) * HEATMAP_GAP_RATIO)
            }
            val gap = cell * HEATMAP_GAP_RATIO
            val gridWidth = columns * cell + (columns - 1) * gap
            val gridHeight = 7 * cell + 6 * gap
            val originX = (size.width - gridWidth) / 2
            val originY = labelH + (gridArea - gridHeight) / 2
            val radius = CornerRadius(cell * 0.2f)

            for (label in grid.monthLabels) {
                val column = label.column - firstShown
                if (column < 0) continue
                val x = originX + column * (cell + gap)
                val layout = textMeasurer.measure(text = label.text, style = labelStyle)
                if (x + layout.size.width > size.width) continue
                drawText(textLayoutResult = layout, topLeft = Offset(x, 0f))
            }

            for ((weekIndex, week) in shown.withIndex()) {
                for ((dayIndex, day) in week.withIndex()) {
                    // Leading / trailing placeholders pad the first and
                    // last column to a full week; they draw nothing.
                    if (day == null) continue
                    drawRoundRect(
                        color = buckets[bucketIndex(day.count, grid.thresholds)],
                        topLeft = Offset(originX + weekIndex * (cell + gap), originY + dayIndex * (cell + gap)),
                        size = Size(cell, cell),
                        cornerRadius = radius,
                    )
                }
            }
        }
    }
}

private class MonthLabel(val column: Int, val text: String)

private class HeatmapGrid(
    /** One list per week, exactly 7 entries, row 0 = Sunday; null pads. */
    val columns: List<List<ActivityDay?>>,
    val monthLabels: List<MonthLabel>,
    /** Upper bounds (inclusive) of buckets 1–3; anything above is bucket 4. */
    val thresholds: IntArray,
)

/**
 * Chunk the trailing year into weekday-aligned 7-day columns (web
 * `buildGrid`): the first day's weekday decides how many leading
 * placeholders pad the first column, so a row is always the same weekday.
 * Locale reads happen here, in a plain function, because lint's
 * NonObservableLocale rejects them in a composable body.
 */
private fun buildHeatmapGrid(days: List<ActivityDay>): HeatmapGrid {
    val tail = days.takeLast(HEATMAP_MAX_WEEKS * 7)
    if (tail.isEmpty()) return HeatmapGrid(emptyList(), emptyList(), intArrayOf(1, 2, 3))
    val dates = tail.map { parseDay(it.date) }
    // java.time weeks run Monday=1 … Sunday=7; `% 7` makes Sunday row 0.
    val leading = dates.first()?.let { it.dayOfWeek.value % 7 } ?: 0
    val weeks = (leading + tail.size + 6) / 7
    val cells = arrayOfNulls<ActivityDay>(weeks * 7)
    tail.forEachIndexed { i, day -> cells[leading + i] = day }
    val columns = (0 until weeks).map { week -> (0 until 7).map { row -> cells[week * 7 + row] } }

    val labels = ArrayList<MonthLabel>()
    var prevMonth = -1
    val locale = Locale.getDefault()
    for ((i, date) in dates.withIndex()) {
        if (date == null || date.monthValue == prevMonth) continue
        prevMonth = date.monthValue
        val column = (leading + i) / 7
        if (labels.isNotEmpty() && column - labels.last().column < MIN_MONTH_LABEL_GAP_COLS) continue
        labels += MonthLabel(column, date.month.getDisplayName(java.time.format.TextStyle.SHORT, locale))
    }
    return HeatmapGrid(columns, labels, quantileThresholds(tail))
}

/** `YYYY-MM-DD` (UTC) → LocalDate; a malformed day is skipped, not fatal. */
private fun parseDay(iso: String): LocalDate? = runCatching { LocalDate.parse(iso) }.getOrNull()

/**
 * Quartile cut-offs over the user's non-zero days (web `computeThresholds`).
 * Falls back to small fixed values with too little data to quantile — a
 * brand-new account renders, without claiming resolution it lacks.
 */
private fun quantileThresholds(days: List<ActivityDay>): IntArray {
    val active = days.map { it.count }.filter { it > 0 }.sorted()
    if (active.isEmpty()) return intArrayOf(1, 2, 3)
    fun q(p: Double): Int = active[min(active.size - 1, floor(active.size * p).toInt())]
    return intArrayOf(q(0.25), q(0.5), q(0.75))
}

/** Bucket 0 is the zero-day cell; boundaries are inclusive on the low side. */
private fun bucketIndex(count: Int, thresholds: IntArray): Int = when {
    count <= 0 -> 0
    count <= thresholds[0] -> 1
    count <= thresholds[1] -> 2
    count <= thresholds[2] -> 3
    else -> 4
}

// MARK: Activity curve

/** Skip month ticks that would collide (web `MIN_LABEL_GAP_PX`). */
private const val MIN_TICK_GAP_PX = 28

/**
 * The web's ActivityLineChart: commands per day as a smoothed line with a
 * soft area fill, over the same dense `/me/activity` payload.
 *
 * The series is a Catmull-Rom curve (cubic Béziers through every point):
 * daily counts are spiky by nature, and the smoothing keeps the trend
 * legible without hiding the spikes — it passes through the data, so it
 * does not overshoot like a loose spline. The y axis scales to a "nice"
 * 1 / 2 / 5 × 10ⁿ ceiling with a midline gridline so magnitude is readable
 * at a glance; month boundaries get a short label in the bottom gutter.
 * No hover on a phone, so the web's snap-to-day tooltip is not ported.
 */
@Composable
private fun ActivityCurve(days: List<ActivityDay>) {
    val series = remember(days) { buildCurve(days) }
    val palette = argusPalette
    val line = if (palette.isDark) CURVE_DARK else CURVE_LIGHT
    val gridColor = palette.surface2
    val textMeasurer = rememberTextMeasurer()
    val labelStyle = captionStyle().copy(fontSize = 10.sp, color = tertiaryTextColor)

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            buildString {
                append(TokenFormat.grouped(series.total.toDouble()))
                append(" command")
                if (series.total != 1) append("s")
                append(" in the last year")
                if (series.peak > 0) append(" · peak ${TokenFormat.grouped(series.peak.toDouble())}/day")
            },
            style = captionStyle(),
            color = secondaryTextColor,
        )
        Canvas(modifier = Modifier.fillMaxWidth().height(CHART_HEIGHT)) {
            val padLeft = 30.dp.toPx() // room for the y-axis count labels
            val padRight = 6.dp.toPx()
            val padTop = 6.dp.toPx()
            val axisH = 16.dp.toPx() // bottom gutter for month labels
            val plotW = max(0f, size.width - padLeft - padRight)
            val plotH = size.height - padTop - axisH
            val n = series.counts.size
            // x(i): even spacing across the window. y(count): top-down, so
            // a larger count sits higher. niceMax is ≥ 1, so never /0.
            fun xOf(i: Int): Float = padLeft + if (n <= 1) 0f else i.toFloat() / (n - 1) * plotW
            fun yOf(count: Float): Float = padTop + plotH - count / series.niceMax * plotH

            // Gridlines + labels at 0, mid, max.
            for (value in floatArrayOf(0f, series.niceMax / 2, series.niceMax)) {
                val y = yOf(value)
                drawLine(
                    color = gridColor,
                    start = Offset(padLeft, y),
                    end = Offset(size.width - padRight, y),
                    strokeWidth = 1.dp.toPx(),
                )
                val layout = textMeasurer.measure(text = formatCount(value), style = labelStyle)
                drawText(
                    textLayoutResult = layout,
                    topLeft = Offset(padLeft - 6.dp.toPx() - layout.size.width, y - layout.size.height / 2f),
                )
            }

            // Month labels along the bottom.
            for (tick in series.monthTicks) {
                val x = xOf(tick.column)
                val layout = textMeasurer.measure(text = tick.text, style = labelStyle)
                if (x + layout.size.width > size.width) continue
                drawText(textLayoutResult = layout, topLeft = Offset(x, size.height - layout.size.height))
            }

            if (n == 0) return@Canvas
            val points = List(n) { i -> Offset(xOf(i), yOf(series.counts[i])) }
            val baseY = padTop + plotH
            val area = Path()
            appendSmooth(area, points)
            area.lineTo(points.last().x, baseY)
            area.lineTo(points.first().x, baseY)
            area.close()
            drawPath(
                path = area,
                brush = Brush.verticalGradient(
                    colors = listOf(line.copy(alpha = 0.22f), line.copy(alpha = 0f)),
                    startY = padTop,
                    endY = baseY,
                ),
            )
            val stroke = Path()
            appendSmooth(stroke, points)
            drawPath(
                path = stroke,
                color = line,
                style = Stroke(width = 1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
    }
}

private class CurveSeries(
    val counts: FloatArray,
    val niceMax: Float,
    /** `column` here is the day INDEX of each labelled month start. */
    val monthTicks: List<MonthLabel>,
    val total: Int,
    val peak: Int,
)

/**
 * Counts, the nice ceiling, and the first day of each month labelled with
 * the locale-short month name (web `buildMonthTicks`). Ticks closer than
 * the gap estimated from a nominal 600 px width are skipped — a label
 * every ~30 days reads fine without a width round-trip.
 */
private fun buildCurve(days: List<ActivityDay>): CurveSeries {
    val counts = FloatArray(days.size) { days[it].count.toFloat() }
    val peak = days.maxOfOrNull { it.count } ?: 0
    val ticks = ArrayList<MonthLabel>()
    var prevMonth = -1
    var prevIndex = Int.MIN_VALUE / 2
    val minGapDays = max(1, (MIN_TICK_GAP_PX / 600.0 * days.size).roundToInt())
    val locale = Locale.getDefault()
    for ((i, day) in days.withIndex()) {
        val date = parseDay(day.date) ?: continue
        if (date.monthValue == prevMonth) continue
        prevMonth = date.monthValue
        if (i - prevIndex < minGapDays) continue
        prevIndex = i
        ticks += MonthLabel(i, date.month.getDisplayName(java.time.format.TextStyle.SHORT, locale))
    }
    return CurveSeries(counts, niceCeil(peak), ticks, days.sumOf { it.count }, peak)
}

/**
 * Catmull-Rom → cubic Bézier: a path through every point with C1
 * continuity (web `smoothPath`). Appends to [path] so the line and the
 * closed area share one routine.
 */
private fun appendSmooth(path: Path, points: List<Offset>) {
    if (points.isEmpty()) return
    path.moveTo(points[0].x, points[0].y)
    if (points.size == 1) return
    for (i in 0 until points.size - 1) {
        val p0 = points.getOrElse(i - 1) { points[i] }
        val p1 = points[i]
        val p2 = points[i + 1]
        val p3 = points.getOrElse(i + 2) { p2 }
        path.cubicTo(
            p1.x + (p2.x - p0.x) / 6f,
            p1.y + (p2.y - p0.y) / 6f,
            p2.x - (p3.x - p1.x) / 6f,
            p2.y - (p3.y - p1.y) / 6f,
            p2.x,
            p2.y,
        )
    }
}

/** Smallest "nice" ceiling (1 / 2 / 5 × 10ⁿ) at or above [n], min 1. */
private fun niceCeil(n: Int): Float {
    if (n <= 1) return 1f
    val exp = floor(log10(n.toDouble())).toInt()
    val base = 10.0.pow(exp)
    for (step in intArrayOf(1, 2, 5, 10)) {
        val candidate = step * base
        if (candidate >= n) return candidate.toFloat()
    }
    return (10 * base).toFloat()
}

/** Y-axis label: `0`, `50`, `1k`, `1.5k`. */
private fun formatCount(value: Float): String {
    val rounded = value.roundToInt()
    if (rounded < 1000) return rounded.toString()
    return if (rounded % 1000 == 0) "${rounded / 1000}k" else String.format(Locale.ROOT, "%.1fk", rounded / 1000.0)
}

// MARK: Labels

/** Display name for a CLI type (web `labelForAgentType`); unknown types pass through. */
private fun agentLabel(type: AgentType): String = when (type) {
    KnownAgentType.CLAUDE_CODE -> "Claude Code"
    KnownAgentType.CODEX -> "Codex"
    KnownAgentType.CURSOR_CLI -> "Cursor CLI"
    else -> type
}

/**
 * Future-relative reset time (web `formatResetAt`): "now", "in 12m",
 * "in 2.5h", "in 3d". `RelativeTime.short` is past-relative and clamps a
 * future instant to "now", so it cannot be reused here.
 */
private fun formatResetAt(iso: String, now: Long): String {
    val at = ISO8601.parseMillis(iso) ?: return iso
    val diffMs = at - now
    if (diffMs <= 0) return "now"
    val minutes = diffMs / 60_000.0
    if (minutes < 60) return "in ${minutes.roundToInt()}m"
    val hours = minutes / 60
    if (hours < 24) return "in " + String.format(Locale.ROOT, if (hours < 10) "%.1fh" else "%.0fh", hours)
    val days = hours / 24
    return "in " + String.format(Locale.ROOT, if (days < 10) "%.1fd" else "%.0fd", days)
}

/** "checked 5m ago" / "checked just now" from the probe's `checkedAt`; null when unknown. */
private fun checkedLabel(iso: String, now: Long): String? {
    if (iso.isEmpty()) return null
    val short = RelativeTime.short(iso, now)
    if (short.isEmpty()) return null
    return if (short == "now") "checked just now" else "checked $short ago"
}
