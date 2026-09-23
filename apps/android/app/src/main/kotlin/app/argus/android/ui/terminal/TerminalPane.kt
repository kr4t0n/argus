@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.argus.android.AppModel
import app.argus.android.TerminalSink
import app.argus.android.ui.theme.argusPalette
import app.argus.core.api.ApiError
import app.argus.core.engine.ProjectRef
import app.argus.core.model.TerminalDTO
import app.argus.core.realtime.TerminalClosedPayload
import app.argus.core.realtime.TerminalOutputPayload
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val TERMINAL_PAGE = "file:///android_asset/terminal.html"
private const val TERMINAL_BRIDGE = "AndroidTerminal"

/** The pane's explicit lifecycle — the web `Status` union, one for one. */
sealed interface TerminalState {
    data object Idle : TerminalState
    data object Opening : TerminalState
    data class Open(val terminal: TerminalDTO) : TerminalState
    data class Closed(val terminal: TerminalDTO, val exitCode: Int?, val reason: String?) : TerminalState
    data class Error(val message: String) : TerminalState
}

/**
 * Interactive PTY bound to a project (machine + cwd) — the port of the
 * web's `TerminalPane.tsx`: the same xterm.js, hosted in a WebView from
 * `assets/terminal.html`, with the same explicit lifecycle (idle CTA →
 * open shell with close → settled shell with dismiss / restart).
 *
 * The transport is the socket's terminal events: the pane registers as
 * `AppModel.activeTerminal` while composed, receives `terminal:output`
 * (base64 bytes, seq-guarded against the duplicate a reconnect can
 * replay) and `terminal:closed`, and sends input / resize / close back.
 * Output that arrives before the page reports `ready` is buffered.
 * Leaving the tab tears the view down and leaves the room but does NOT
 * close the PTY — as on the web, the sidecar reaps it when the shell
 * exits or the per-sidecar cap is hit.
 */
@Composable
fun TerminalPane(app: AppModel, project: ProjectRef, machineName: String?, modifier: Modifier = Modifier) {
    val controller = remember(project.projectId) { TerminalController(app, project) }
    val state by controller.state
    val dark = argusPalette.isDark

    DisposableEffect(controller) {
        app.activeTerminal = controller
        onDispose {
            if (app.activeTerminal === controller) app.activeTerminal = null
            controller.teardown()
        }
    }
    LaunchedEffect(dark) { controller.setTheme(dark) }

    Column(modifier.fillMaxSize()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when (state) {
                TerminalState.Idle -> IconButton(onClick = { controller.open() }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.PlayArrow, contentDescription = "Open shell", modifier = Modifier.size(16.dp))
                }
                TerminalState.Opening -> CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp)
                is TerminalState.Open -> IconButton(onClick = { controller.close() }, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.Close, contentDescription = "Close shell", modifier = Modifier.size(16.dp))
                }
                is TerminalState.Closed, is TerminalState.Error -> {
                    IconButton(onClick = { controller.dismiss() }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Default.Close, contentDescription = "Dismiss", modifier = Modifier.size(16.dp))
                    }
                    IconButton(onClick = { controller.restart() }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Default.Refresh, contentDescription = "New shell", modifier = Modifier.size(16.dp))
                    }
                }
            }
        }
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            when (val s = state) {
                TerminalState.Idle -> Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        "Open a shell on ${machineName ?: "this machine"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    TextButton(onClick = { controller.open() }) { Text("Open shell") }
                }
                TerminalState.Opening -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                is TerminalState.Error -> Text(
                    s.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(16.dp),
                )
                is TerminalState.Open, is TerminalState.Closed -> AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx -> controller.attachWebView(ctx) },
                    // Destroyed only once it has left the view tree —
                    // WebView.destroy() wants the view detached first.
                    onRelease = { controller.releaseWebView(it) },
                )
            }
        }
    }
}

/**
 * Owns the shell's socket-side state and the WebView. `internal` because
 * the WebView enumerates the bridge reflectively (public annotated
 * methods on a public class).
 */
internal class TerminalController(
    private val app: AppModel,
    private val project: ProjectRef,
) : TerminalSink {
    val state: MutableState<TerminalState> = mutableStateOf(TerminalState.Idle)

    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var pageReady = false
    private var dark = true
    private val pendingOutput = ArrayList<String>()
    private var lastSeq = 0L

    override var terminalId: String? = null
        private set

    fun open() {
        val client = app.client ?: return
        state.value = TerminalState.Opening
        app.scope.launch {
            try {
                // xterm-fit reports the real size once the page mounts;
                // this initial guess only shapes the first prompt line.
                val terminal = client.openProjectTerminal(project.projectId, cols = 80, rows = 24)
                terminalId = terminal.id
                lastSeq = 0
                app.stream?.joinTerminal(terminal.id)
                state.value = TerminalState.Open(terminal)
            } catch (e: Exception) {
                app.handleApiError(e)
                state.value = TerminalState.Error((e as? ApiError)?.message ?: e.message ?: "failed to open terminal")
            }
        }
    }

    fun close() {
        terminalId?.let { app.stream?.sendTerminalClose(it) }
    }

    fun dismiss() {
        teardown()
        state.value = TerminalState.Idle
    }

    fun restart() {
        teardown()
        open()
    }

    /**
     * Leave the room and forget the view; the PTY itself is left to the
     * sidecar. The WebView is destroyed by [releaseWebView] once Compose
     * has detached it, not here.
     */
    fun teardown() {
        terminalId?.let { app.stream?.leaveTerminal(it) }
        terminalId = null
        lastSeq = 0
        pageReady = false
        pendingOutput.clear()
        webView = null
    }

    /** AndroidView's onRelease: the view has left the tree and can be destroyed. */
    fun releaseWebView(view: WebView) {
        if (webView === view) {
            webView = null
            pageReady = false
        }
        view.destroy()
    }

    fun setTheme(dark: Boolean) {
        this.dark = dark
        if (pageReady) evaluate("window.argusTerm.setTheme($dark)")
    }

    // MARK: TerminalSink (socket events, main thread)

    override fun onOutput(payload: TerminalOutputPayload) {
        if (payload.terminalId != terminalId) return
        if (payload.seq <= lastSeq) return // duplicate after reconnect
        lastSeq = payload.seq
        if (pageReady) evaluate("window.argusTerm.write('${payload.data}')") else pendingOutput.add(payload.data)
    }

    override fun onClosed(payload: TerminalClosedPayload) {
        if (payload.terminalId != terminalId) return
        val current = state.value as? TerminalState.Open ?: return
        state.value = TerminalState.Closed(current.terminal, payload.exitCode, payload.reason)
        // The web's closing banner: the exit code stays visible above the
        // scrollback instead of the pane going blank.
        val banner = "\r\n\u001b[2m[process exited with code ${payload.exitCode ?: "?"}" +
            (payload.reason?.let { " — $it" } ?: "") + "]\u001b[0m\r\n"
        evaluate("window.argusTerm.writeText(${jsLiteral(banner)})")
    }

    override fun handleReconnect() {
        terminalId?.let { app.stream?.joinTerminal(it) }
    }

    // MARK: WebView

    @SuppressLint("SetJavaScriptEnabled")
    fun attachWebView(context: Context): WebView {
        webView?.let { return it }
        pageReady = false
        val view = WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
            isFocusable = true
            isFocusableInTouchMode = true
            webViewClient = object : WebViewClient() {
                /** Only the initial asset load; nothing the page attempts can navigate anywhere. */
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    main.post {
                        webView = null
                        pageReady = false
                        state.value = TerminalState.Error("The terminal view crashed. Dismiss and open a new shell.")
                    }
                    return true
                }
            }
            addJavascriptInterface(TerminalBridge(main, ::onBridgeMessage), TERMINAL_BRIDGE)
            loadUrl(TERMINAL_PAGE)
        }
        webView = view
        return view
    }

    private fun onBridgeMessage(kind: String, value: String) {
        when (kind) {
            "ready" -> {
                pageReady = true
                evaluate("window.argusTerm.setTheme($dark)")
                for (data in pendingOutput) evaluate("window.argusTerm.write('$data')")
                pendingOutput.clear()
                evaluate("window.argusTerm.fit(); window.argusTerm.focus()")
                webView?.requestFocus()
            }
            "input" -> terminalId?.let { app.stream?.sendTerminalInput(it, value) }
            "resize" -> {
                val id = terminalId ?: return
                val parts = value.split(',')
                val cols = parts.getOrNull(0)?.toIntOrNull() ?: return
                val rows = parts.getOrNull(1)?.toIntOrNull() ?: return
                if (cols > 0 && rows > 0) app.stream?.sendTerminalResize(id, cols, rows)
            }
        }
    }

    private fun evaluate(script: String) {
        webView?.evaluateJavascript(script, null)
    }

    /** A JS string literal: JSON quoting is valid JS once the two line separators JSON leaves raw are escaped. */
    private fun jsLiteral(text: String): String =
        JSONObject.quote(text).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
}

/**
 * Receives the host page's `post(kind, value)`. JavaScript interface
 * methods run on a WebView-owned thread, so every message hops to the
 * main looper before touching state.
 */
internal class TerminalBridge(
    private val main: Handler,
    private val onMessage: (kind: String, value: String) -> Unit,
) {
    @JavascriptInterface
    fun post(kind: String, value: String) {
        main.post { onMessage(kind, value) }
    }
}
