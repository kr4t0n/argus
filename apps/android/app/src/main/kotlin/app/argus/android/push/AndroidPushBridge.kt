package app.argus.android.push

import android.content.Context
import app.argus.core.model.PushConfigDTO
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The real [PushBridge]: Firebase Cloud Messaging for tokens and
 * [TurnNotifications] for the banners.
 *
 * Firebase is initialised at RUNTIME from the server's public client
 * identifiers rather than from a build-time `google-services.json`, so
 * one APK works against any Argus server (the plan's "one APK for any
 * server"). Consequences worth knowing:
 *
 * - There is no google-services Gradle plugin and no generated resources;
 *   Firebase's auto-init content provider finds no default options at
 *   process start and logs a warning, which is expected.
 * - `FirebaseApp.initializeApp(context, options)` throws if the default
 *   app already exists, so [initialize] compares options and deletes the
 *   stale app before re-initialising when the server changed.
 * - Auto-init is disabled in the manifest, so no token is minted until
 *   the user turns the toggle on; [token] requests one explicitly.
 */
class AndroidPushBridge(
    private val context: Context,
    private val notifications: TurnNotifications,
) : PushBridge {
    override fun initialize(config: PushConfigDTO) {
        val options = FirebaseOptions.Builder()
            .setProjectId(config.projectId)
            .setApplicationId(config.applicationId)
            .setApiKey(config.apiKey)
            .setGcmSenderId(config.senderId)
            .build()
        val existing = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        if (existing != null) {
            if (existing.options == options) return
            existing.delete()
        }
        FirebaseApp.initializeApp(context, options)
    }

    override suspend fun token(): String = FirebaseMessaging.getInstance().token.await()

    override suspend fun deleteToken() {
        FirebaseMessaging.getInstance().deleteToken().await()
    }

    override fun cancel(sessionId: String) = notifications.cancel(sessionId)

    override fun reconcile(unreadSessionIds: Set<String>) = notifications.reconcile(unreadSessionIds)
}

/** Bridge a Play-services `Task` into a coroutine — the only Task API the
 *  app touches, so `kotlinx-coroutines-play-services` is not worth a pin. */
private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        if (task.isSuccessful) {
            @Suppress("UNCHECKED_CAST")
            continuation.resume(task.result as T)
        } else {
            continuation.resumeWithException(task.exception ?: IllegalStateException("Firebase task failed"))
        }
    }
}
