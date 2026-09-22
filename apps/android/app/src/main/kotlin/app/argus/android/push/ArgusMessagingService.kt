package app.argus.android.push

import app.argus.android.ArgusApplication
import app.argus.android.Route
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives FCM data messages (see the server's `FcmTransport` for why
 * every message is a data message) and token rotations.
 *
 * `type: turn` — a turn finished: render the banner unless the user is
 * looking at that very session (web/iOS parity: never nag about what is
 * on screen). `type: clear` — the session was read on another client or
 * a fresh turn superseded the result: withdraw the banner. Runs on a
 * background thread, in any process state short of force-stop; the
 * process-scoped [app.argus.android.AppModel] is reachable through the
 * Application either way, and only thread-safe reads happen here.
 */
class ArgusMessagingService : FirebaseMessagingService() {
    private val app get() = (application as ArgusApplication)

    override fun onNewToken(token: String) {
        app.appModel.onPushTokenRotated(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val sessionId = data["sessionId"] ?: return
        when (data["type"]) {
            "turn" -> {
                val model = app.appModel
                if (model.isForeground && model.route.value == Route.Session(sessionId)) return
                app.turnNotifications.show(
                    sessionId = sessionId,
                    title = data["title"].orEmpty().ifEmpty { "Argus" },
                    body = data["body"].orEmpty(),
                    failed = data["failed"] == "1",
                )
            }
            "clear" -> app.turnNotifications.cancel(sessionId)
        }
    }
}
