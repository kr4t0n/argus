package app.argus.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.argus.android.AppModel
import app.argus.android.Route
import app.argus.android.ui.components.CloneFailureToasts
import app.argus.android.ui.login.LoginScreen
import app.argus.android.ui.session.SessionScreen
import app.argus.android.ui.sessions.SessionListScreen

/**
 * Root: the phase switch (launching / login / ready) and, once ready, a
 * two-level phone navigation — the session list, or one session. State
 * lives in [AppModel] (process-scoped), so this is a pure projection;
 * the tablet split layout is a Phase 3 refinement.
 */
@Composable
fun ArgusApp(app: AppModel) {
    val phase by app.phase.collectAsState()
    LaunchedEffect(Unit) { app.bootstrap() }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when (phase) {
            AppModel.Phase.Launching -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            AppModel.Phase.LoggedOut -> LoginScreen(app)
            AppModel.Phase.Ready -> Box(Modifier.fillMaxSize()) {
                MainNavigation(app)
                CloneFailureToasts(app, modifier = Modifier.align(Alignment.BottomCenter))
            }
        }
    }
}

@Composable
private fun MainNavigation(app: AppModel) {
    val route by app.route.collectAsState()
    when (val current = route) {
        is Route.Session -> {
            BackHandler { app.navigate(null) }
            SessionScreen(app = app, sessionId = current.id, onBack = { app.navigate(null) })
        }
        null -> SessionListScreen(app = app, onOpenSession = { app.navigate(Route.Session(it)) })
    }
}
