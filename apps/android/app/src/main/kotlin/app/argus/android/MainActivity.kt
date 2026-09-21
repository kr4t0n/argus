package app.argus.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview

/**
 * Phase 0 shell: proves the Compose toolchain end to end in CI. The real
 * root (server/login → session list → transcript) arrives in Phase 2.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { ArgusApp() }
    }
}

@Composable
fun ArgusApp() {
    MaterialTheme {
        Surface(modifier = Modifier.fillMaxSize()) {
            Text(text = "Argus")
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun ArgusAppPreview() {
    ArgusApp()
}
