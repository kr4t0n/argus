package app.argus.android.push

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.argus.android.MainActivity
import app.argus.android.R

/**
 * The turn-finished notification — the Android rendering of what the
 * server sends APNs as an alert and FCM as a `type: turn` data message
 * (see the server's `FcmTransport` for why the app renders it itself).
 *
 * One notification per session: it is posted under the session id as
 * its TAG (with a fixed id), so a newer completion in the same session
 * replaces the older banner instead of stacking — the web's
 * notification `tag`, APNs' collapse id. The same tag is what the
 * read-sync clear and the foreground sweep cancel by.
 *
 * Tapping deep-links into the session: the content intent carries the
 * session id as an extra and reaches `MainActivity` either fresh
 * (`onCreate`) or, with `singleTop`, as `onNewIntent`.
 */
class TurnNotifications(private val context: Context) {
    private val manager: NotificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    /** Create the channel (idempotent; minSdk 26 so it always exists).
     *  HIGH importance for a heads-up banner — the iOS alert and the
     *  web's desktop notification both interrupt; the user can lower it
     *  per channel in system settings. */
    fun ensureChannel() {
        val channel = NotificationChannel(
            CHANNEL_TURNS,
            "Task completion",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "A turn finished in a session you were not looking at"
        }
        manager.createNotificationChannel(channel)
    }

    /**
     * Post (or replace) the session's banner. No-op without the
     * POST_NOTIFICATIONS grant on Android 13+ — the toggle requests it
     * before registering, so this only guards a later revocation.
     */
    // The runtime grant is checked right here (13+; below that the
    // permission does not exist and cannot be revoked), which is the
    // check lint's MissingPermission wants but does not always recognise
    // through the SDK_INT branch.
    @SuppressLint("MissingPermission")
    fun show(sessionId: String, title: String, body: String, failed: Boolean) {
        if (!notificationsAllowed(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_TURNS)
            .setSmallIcon(R.drawable.ic_stat_argus)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(if (failed) NotificationCompat.CATEGORY_ERROR else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_SOUND)
            .setContentIntent(sessionTapIntent(context, sessionId))
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(sessionId, TURN_ID, notification)
    }

    fun cancel(sessionId: String) {
        NotificationManagerCompat.from(context).cancel(sessionId, TURN_ID)
    }

    /**
     * Withdraw every turn banner whose session is not in [unreadSessionIds].
     * Runs from `refreshAll`, so it covers cold launch, foreground and
     * reconnect alike — the server's live clear is best-effort (a data
     * message is throttled in Doze and never delivered to a force-stopped
     * app), and the server's outstanding-banner set forgets on restart.
     */
    fun reconcile(unreadSessionIds: Set<String>) {
        for (active in manager.activeNotifications) {
            val tag = active.tag ?: continue
            if (active.id != TURN_ID) continue
            if (tag !in unreadSessionIds) cancel(tag)
        }
    }

    companion object {
        const val CHANNEL_TURNS = "turns"
        const val TURN_ID = 1
        const val EXTRA_SESSION_ID = "app.argus.android.extra.SESSION_ID"

        /** POST_NOTIFICATIONS granted (13+) and the app not muted in settings. */
        fun notificationsAllowed(context: Context): Boolean {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                if (granted != PackageManager.PERMISSION_GRANTED) return false
            }
            return NotificationManagerCompat.from(context).areNotificationsEnabled()
        }

        /**
         * The deep link into a session. A distinct request code per
         * session, or every banner's PendingIntent would collapse into one
         * (extras are not part of Intent identity) and each tap would open
         * the last session. Shared by the completion banner and the live
         * card, which therefore tap through to the same place.
         */
        fun sessionTapIntent(context: Context, sessionId: String): PendingIntent {
            val tap = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                putExtra(EXTRA_SESSION_ID, sessionId)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            return PendingIntent.getActivity(
                context,
                sessionId.hashCode(),
                tap,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
    }
}
