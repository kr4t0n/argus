package app.argus.android

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
