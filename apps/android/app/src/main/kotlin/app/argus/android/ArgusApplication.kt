package app.argus.android

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.argus.android.push.AndroidPushBridge
import app.argus.android.push.TurnNotifications

/**
 * Process-scoped owner of [AppModel]: auth, the socket, stores and the
 * session view-model cache survive activity recreation (rotation,
 * theme change) because they hang off the Application, not the
 * Activity — the Android stand-in for the iOS app's `@State` AppModel on
 * the `App` struct.
 */
class ArgusApplication : Application() {
    lateinit var appModel: AppModel
        private set

    /** The turn-finished banners; shared with the messaging service. */
    lateinit var turnNotifications: TurnNotifications
        private set

    override fun onCreate() {
        super.onCreate()
        turnNotifications = TurnNotifications(this).also { it.ensureChannel() }
        appModel = AppModel(getSharedPreferences(PREFS_NAME, MODE_PRIVATE))
        appModel.push = AndroidPushBridge(this, turnNotifications)
        // A process started by an incoming FCM message never runs the
        // login path that initialises Firebase; re-initialise from the
        // cached client config so the messaging service has a default
        // app whenever push was left on.
        appModel.initializePushFromCache()
        // Foregrounding is treated like a cold start (full snapshot +
        // rejoin rooms) — the robust catch-up path after Doze or a
        // backgrounded socket, mirroring the iOS scenePhase handler. The
        // foreground flag is what the messaging service consults to
        // suppress a banner for the session on screen.
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    appModel.isForeground = true
                    appModel.handleForeground()
                }

                override fun onStop(owner: LifecycleOwner) {
                    appModel.isForeground = false
                }
            },
        )
    }

    companion object {
        const val PREFS_NAME = "argus"
    }
}
