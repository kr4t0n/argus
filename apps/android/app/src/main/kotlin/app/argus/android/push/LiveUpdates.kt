package app.argus.android.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.argus.android.R
import app.argus.core.model.AgentType
import app.argus.core.model.ResultChunk
import app.argus.core.model.ResultKind
import app.argus.core.model.SessionDTO
import app.argus.core.model.SessionStatus
import app.argus.core.model.asString

/**
 * What [app.argus.android.AppModel] needs from the lock-screen live-turn
 * card, behind an interface for the same reason as [PushBridge].
 * Mirrors the iOS `LiveActivityManager` surface.
 */
interface LiveUpdateBridge {
    /** Put a running turn on the lock screen (idempotent per session). */
    fun start(session: SessionDTO, agentType: AgentType)

    /** A chunk streamed: tool chunks advance the counters (throttled render). */
    fun noteChunk(sessionId: String, chunk: ResultChunk)

    /** Resolve the card to ✓/✗; it lingers a few minutes then dismisses itself. */
    fun end(sessionId: String, failed: Boolean)

    /** Foreground reconcile: end any tracked (or leftover) card whose session is no longer running. */
    fun reconcile(status: (String) -> SessionStatus?)

    fun endAll()

    /** A server-pushed update (`type: live` data message), any thread. */
    fun applyPush(sessionId: String, event: String, state: String, toolCount: Int, lastTool: String, title: String)
}

/**
 * Android Live Updates for running turns — the counterpart of the iOS
 * Live Activity: one ongoing notification per session carrying the
 * session title, tool count, last tool and elapsed time, resolving to
 * ✓/✗ when the turn settles. On Android 16+ it asks to be PROMOTED
 * (`setRequestPromotedOngoing`, the `POST_PROMOTED_NOTIFICATIONS`
 * permission in the manifest) so it rides the status bar and lock
 * screen as a Live Update, with `ProgressStyle` and the tool count as
 * the short critical text; below 16 it is a plain ongoing notification
 * with the same content and no promotion.
 *
 * Lifecycle: the app starts a card when a turn begins in the session on
 * screen or one submitted from this device. While foregrounded, updates
 * are local, throttled to one render per 2 s (leading edge) with a
 * trailing flush so a burst's final state always renders; when push is
 * on the device token is registered per session ([onStarted]) and the
 * server drives the card with FCM data messages once the app is
 * backgrounded — including the `end` that resolves it. A pushed update
 * for a session this process does not know (the app was killed) starts
 * the card from the pushed counters. `end` cancels any pending flush so
 * a settled card cannot flip back to running.
 *
 * Every mutation runs on the main looper: the socket pump is already
 * main-thread, and [applyPush] hops from the messaging service's thread.
 */
class LiveUpdateManager(
    private val context: Context,
    private val onStarted: (sessionId: String) -> Unit,
    private val onEnded: (sessionId: String) -> Unit,
) : LiveUpdateBridge {
    private class LiveTurn(
        var title: String,
        val startedAt: Long,
        var toolCount: Int = 0,
        var lastTool: String = "",
        var lastRenderAt: Long = 0L,
        var pendingFlush: Runnable? = null,
        /** Registered with the server, so `end` must unregister. */
        val registered: Boolean,
    )

    private val main = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val turns = HashMap<String, LiveTurn>()

    fun ensureChannel() {
        val channel = NotificationChannel(CHANNEL_LIVE, "Running turns", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A live card for a turn in progress; resolves when it finishes"
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    override fun start(session: SessionDTO, agentType: AgentType) {
        if (turns.containsKey(session.id)) return
        if (!TurnNotifications.notificationsAllowed(context)) return
        val turn = LiveTurn(title = session.title, startedAt = System.currentTimeMillis(), registered = true)
        turns[session.id] = turn
        render(session.id, turn)
        onStarted(session.id)
    }

    override fun noteChunk(sessionId: String, chunk: ResultChunk) {
        if (chunk.kind != ResultKind.TOOL) return
        val turn = turns[sessionId] ?: return
        turn.toolCount += 1
        val firstLine = chunk.content.orEmpty().trim().lineSequence().firstOrNull().orEmpty()
        turn.lastTool = firstLine.ifEmpty { chunk.meta?.get("tool")?.asString ?: "tool" }
        val now = System.currentTimeMillis()
        val elapsed = now - turn.lastRenderAt
        if (elapsed < THROTTLE_MS) {
            scheduleTrailingFlush(sessionId, turn, THROTTLE_MS - elapsed)
            return
        }
        render(sessionId, turn)
    }

    /** One deferred render per window, re-reading the counters at expiry. */
    private fun scheduleTrailingFlush(sessionId: String, turn: LiveTurn, delayMs: Long) {
        if (turn.pendingFlush != null) return
        val flush = Runnable {
            turn.pendingFlush = null
            if (turns[sessionId] === turn) render(sessionId, turn)
        }
        turn.pendingFlush = flush
        main.postDelayed(flush, delayMs.coerceAtLeast(0))
    }

    override fun end(sessionId: String, failed: Boolean) {
        val turn = turns.remove(sessionId) ?: return
        turn.pendingFlush?.let { main.removeCallbacks(it) }
        turn.pendingFlush = null
        renderFinal(sessionId, turn.title, failed, turn.toolCount, turn.lastTool)
        if (turn.registered) onEnded(sessionId)
    }

    override fun reconcile(status: (String) -> SessionStatus?) {
        for (sessionId in turns.keys.toList()) {
            val s = status(sessionId)
            if (s != SessionStatus.ACTIVE) end(sessionId, failed = s == SessionStatus.FAILED)
        }
        // Cards this process never tracked (posted by a previous process
        // from pushed updates) whose session has since settled.
        for (active in manager.activeNotifications) {
            val tag = active.tag ?: continue
            if (active.id != LIVE_ID || tag in turns) continue
            if (active.notification.flags and android.app.Notification.FLAG_ONGOING_EVENT == 0) continue
            val s = status(tag)
            if (s != SessionStatus.ACTIVE) NotificationManagerCompat.from(context).cancel(tag, LIVE_ID)
        }
    }

    override fun endAll() {
        for (sessionId in turns.keys.toList()) end(sessionId, failed = false)
    }

    override fun applyPush(sessionId: String, event: String, state: String, toolCount: Int, lastTool: String, title: String) {
        main.post {
            when (event) {
                "end" -> {
                    val failed = state == "failed"
                    val turn = turns[sessionId]
                    if (turn != null) {
                        turn.toolCount = maxOf(turn.toolCount, toolCount)
                        if (lastTool.isNotEmpty()) turn.lastTool = lastTool
                        end(sessionId, failed)
                    } else {
                        renderFinal(sessionId, title, failed, toolCount, lastTool)
                    }
                }
                "update" -> {
                    // Server-driven: it already throttles, so render at once.
                    // Not registered again — the server only pushes to a
                    // token this device registered, so the row exists.
                    val turn = turns.getOrPut(sessionId) {
                        LiveTurn(title = title, startedAt = System.currentTimeMillis(), registered = true)
                    }
                    if (title.isNotEmpty()) turn.title = title
                    turn.toolCount = maxOf(turn.toolCount, toolCount)
                    if (lastTool.isNotEmpty()) turn.lastTool = lastTool
                    render(sessionId, turn)
                }
            }
        }
    }

    // MARK: Rendering

    private fun render(sessionId: String, turn: LiveTurn) {
        if (!TurnNotifications.notificationsAllowed(context)) return
        turn.lastRenderAt = System.currentTimeMillis()
        val tools = "${turn.toolCount} tool${if (turn.toolCount == 1) "" else "s"}"
        val text = if (turn.lastTool.isEmpty()) "Running · $tools" else "Running · $tools · ${turn.lastTool}"
        val builder = NotificationCompat.Builder(context, CHANNEL_LIVE)
            .setSmallIcon(R.drawable.ic_stat_argus)
            .setContentTitle(turn.title)
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setWhen(turn.startedAt)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setContentIntent(TurnNotifications.sessionTapIntent(context, sessionId))
            .setStyle(NotificationCompat.ProgressStyle().setProgressIndeterminate(true))
        if (Build.VERSION.SDK_INT >= 36) {
            builder.setRequestPromotedOngoing(true).setShortCriticalText(tools)
        }
        post(sessionId, builder)
    }

    private fun renderFinal(sessionId: String, title: String, failed: Boolean, toolCount: Int, lastTool: String) {
        if (!TurnNotifications.notificationsAllowed(context)) return
        val tools = "$toolCount tool${if (toolCount == 1) "" else "s"}"
        val text = (if (failed) "Failed ✗ · " else "Completed ✓ · ") + tools + (if (lastTool.isEmpty()) "" else " · $lastTool")
        val builder = NotificationCompat.Builder(context, CHANNEL_LIVE)
            .setSmallIcon(R.drawable.ic_stat_argus)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(if (failed) NotificationCompat.CATEGORY_ERROR else NotificationCompat.CATEGORY_STATUS)
            .setOngoing(false)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(true)
            // Lingers a few minutes so a just-finished turn is glanceable
            // (the iOS dismissal policy), then goes on its own.
            .setTimeoutAfter(FINAL_LINGER_MS)
            .setContentIntent(TurnNotifications.sessionTapIntent(context, sessionId))
        post(sessionId, builder)
    }

    // The runtime grant is checked by notificationsAllowed() in both
    // callers; lint cannot see through the helper.
    @android.annotation.SuppressLint("MissingPermission")
    private fun post(sessionId: String, builder: NotificationCompat.Builder) {
        NotificationManagerCompat.from(context).notify(sessionId, LIVE_ID, builder.build())
    }

    companion object {
        const val CHANNEL_LIVE = "live"
        /** Distinct from TurnNotifications.TURN_ID so a session's live card and its completion banner coexist by tag. */
        const val LIVE_ID = 2
        private const val THROTTLE_MS = 2_000L
        private const val FINAL_LINGER_MS = 240_000L
    }
}
