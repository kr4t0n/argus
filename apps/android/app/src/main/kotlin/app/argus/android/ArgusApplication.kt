package app.argus.android

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

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

    override fun onCreate() {
        super.onCreate()
        appModel = AppModel(getSharedPreferences(PREFS_NAME, MODE_PRIVATE))
        // Foregrounding is treated like a cold start (full snapshot +
        // rejoin rooms) — the robust catch-up path after Doze or a
        // backgrounded socket, mirroring the iOS scenePhase handler.
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    appModel.handleForeground()
                }
            },
        )
    }

    companion object {
        const val PREFS_NAME = "argus"
    }
}
