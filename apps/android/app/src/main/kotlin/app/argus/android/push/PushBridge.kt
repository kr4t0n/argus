package app.argus.android.push

import app.argus.core.model.PushConfigDTO

/**
 * What [app.argus.android.AppModel] needs from the push platform,
 * behind an interface so the model stays free of Firebase and the
 * notification manager (and so a build without Play services can
 * install a no-op). [AndroidPushBridge] is the real one.
 *
 * Token calls are `suspend` because Firebase mints tokens off-thread
 * (a `Task`); they throw when Play services are missing or the token
 * cannot be minted, and the model turns that into the toggle's footer
 * message.
 */
interface PushBridge {
    /** Initialise Firebase from the server's public client identifiers
     *  (idempotent; re-initialises when the identifiers changed). */
    fun initialize(config: PushConfigDTO)

    /** The current FCM registration token, minting one if needed. */
    suspend fun token(): String

    /** Invalidate this device's token so the server's copy stops working
     *  even if the DELETE that follows never lands. */
    suspend fun deleteToken()

    /** Withdraw the completion banner for one session (read-sync). */
    fun cancel(sessionId: String)

    /** Withdraw every banner whose session is no longer unread — the
     *  foreground sweep for clears a best-effort data message missed. */
    fun reconcile(unreadSessionIds: Set<String>)
}
