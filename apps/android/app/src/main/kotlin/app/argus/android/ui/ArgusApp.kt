package app.argus.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.argus.android.AppModel
import app.argus.android.Route
import app.argus.android.ui.components.CloneFailureToasts
import app.argus.android.ui.login.LoginScreen
import app.argus.android.ui.palette.PaletteHost
import app.argus.android.ui.session.SessionScreen
import app.argus.android.ui.sessions.SessionListScreen

/**
 * Root: the phase switch (launching / login / ready) and, once ready,
 * the main navigation. On a compact width that is a two-level stack —
 * the session list, or one session; from 840dp (the material
 * "expanded" class) it becomes the split the web and iPad show — the
 * list as a left column beside the open session, hideable with Ctrl+B.
 * State lives in [AppModel] (process-scoped), so this is a pure
 * projection.
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
                // Ctrl+P / Ctrl+K / Ctrl+/ share ONE sheet keyed on
                // app.paletteMode: another overlay's hotkey swaps the
                // content in place rather than stacking a second sheet.
                PaletteHost(app = app, onOpenSession = { app.navigate(Route.Session(it)) })
            }
        }
    }
}

@Composable
private fun MainNavigation(app: AppModel) {
    val route by app.route.collectAsState()
    val sidebarVisible by app.sidebarVisible.collectAsState()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val split = maxWidth >= 840.dp
        if (split) {
            Row(Modifier.fillMaxSize()) {
                if (sidebarVisible) {
                    Box(Modifier.width(340.dp).fillMaxHeight()) {
                        SessionListScreen(app = app, onOpenSession = { app.navigate(Route.Session(it)) })
                    }
                    VerticalDivider()
                }
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    when (val current = route) {
                        is Route.Session -> {
                            // Back from a session in the split clears the
                            // detail column rather than leaving the app.
                            BackHandler { app.navigate(null) }
                            // Fresh state per session (composer draft,
                            // pending attachments, inspector tab) — the
                            // detail column swaps in place here.
                            key(current.id) {
                                SessionScreen(
                                    app = app,
                                    sessionId = current.id,
                                    onBack = { app.navigate(null) },
                                    showBack = !sidebarVisible,
                                )
                            }
                        }
                        null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text(
                                "Select a session",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        } else {
            when (val current = route) {
                is Route.Session -> {
                    BackHandler { app.navigate(null) }
                    key(current.id) {
                        SessionScreen(app = app, sessionId = current.id, onBack = { app.navigate(null) })
                    }
                }
                null -> SessionListScreen(app = app, onOpenSession = { app.navigate(Route.Session(it)) })
            }
        }
    }
}
