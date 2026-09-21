package app.argus.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.argus.android.ui.ArgusApp
import app.argus.android.ui.theme.ArgusTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val appModel = (application as ArgusApplication).appModel
        setContent {
            ArgusTheme {
                ArgusApp(appModel)
            }
        }
    }
}
