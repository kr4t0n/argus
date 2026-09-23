package app.argus.android

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.argus.android.push.TurnNotifications
import app.argus.android.ui.ArgusApp
import app.argus.android.ui.theme.ArgusTheme

class MainActivity : ComponentActivity() {
    private lateinit var appModel: AppModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        appModel = (application as ArgusApplication).appModel
        setContent {
            ArgusTheme {
                ArgusApp(appModel)
            }
        }
        // A notification tap on a cold start arrives as the launching
        // intent; only a fresh launch, never a recreate, or a rotation
        // would re-open the tapped session over wherever the user went.
        if (savedInstanceState == null) handleDeepLink(intent)
    }

    /** `singleTop`: a tap while the app is running lands here. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val sessionId = intent?.getStringExtra(TurnNotifications.EXTRA_SESSION_ID) ?: return
        // Consume it so a later getIntent() (recreate) doesn't re-route.
        intent.removeExtra(TurnNotifications.EXTRA_SESSION_ID)
        appModel.openSessionFromNotification(sessionId)
    }

    /**
     * App-level hardware-keyboard bindings. This is the one place the
     * registry is consulted: the view hierarchy sees every key first, so
     * a focused text field keeps its own editing chords and the composer
     * keeps Enter/Escape; whatever it declines lands here, matched
     * against [Hotkeys] and dispatched by scope.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val binding = Hotkeys.match(event)
        if (binding != null && appModel.dispatchHotkey(binding)) return true
        return super.onKeyDown(keyCode, event)
    }
}
