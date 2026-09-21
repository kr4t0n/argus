package app.argus.android.ui.markdown

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.argus.android.ui.theme.argusPalette
import kotlinx.coroutines.delay
import kotlin.math.abs

// The two fence languages that get a rendered view with a Source toggle —
// the Android counterpart of apps/ios/Argus/Sources/Views/MermaidRender.swift
// (MermaidBlock) and MarkdownRender.swift (HtmlBlock), which in turn
// mirror the web's MarkdownCodeBlock + MermaidBlock + HtmlPreview. Plain
// code blocks are NOT here: they stay inside Markdown segments and Markwon
// renders them.

/** The empty-content floor both blocks keep while a page is still loading. */
private const val MIN_BLOCK_HEIGHT_DP = 48

/** Name of the `@JavascriptInterface` object the mermaid host page posts through. */
private const val MERMAID_BRIDGE = "AndroidMermaid"

private const val MERMAID_PAGE = "file:///android_asset/mermaid-android.html"

/**
 * A ```mermaid fenced block: rendered as a diagram by default, with a
 * Source toggle.
 *
 * The diagram is drawn by the vendored `mermaid.min.js` (the SAME file
 * the iOS app bundles, merged into this app's assets — see
 * `MermaidLockstepTest`) inside a WebView, loaded from the app's assets
 * rather than a CDN so air-gapped servers and offline phones still get
 * diagrams. Web parity for the states:
 *
 * - Before anything has parsed, the plain code block shows (the web's
 *   `fallback`); the WebView is composed 1dp tall underneath so the
 *   runtime loads and the first render lands, then the diagram snaps in.
 * - A source that never parses stays a code block with NO error state,
 *   matching the way unparseable LaTeX renders as visible source.
 * - A failed re-render keeps the last good diagram.
 *
 * `AnswerSegments.split` only hands over CLOSED fences, so the source is
 * final by the time it arrives; the streaming debounce (~200 ms, the
 * web's) covers the theoretical churn without costing the settled case
 * anything.
 */
@Composable
fun MermaidBlock(
    source: String,
    modifier: Modifier = Modifier,
    isStreaming: Boolean = false,
) {
    val trimmed = source.trimEnd('\n')
    val dark = argusPalette.isDark
    var showSource by remember { mutableStateOf(false) }
    var heightCss by remember { mutableIntStateOf(0) }
    var ready by remember { mutableStateOf(false) }
    var rendered by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    val lastRender = remember { arrayOf("") }

    val bridge = remember {
        MermaidBridge(Handler(Looper.getMainLooper())) { kind, value ->
            when (kind) {
                "ready" -> ready = true
                "rendered" -> {
                    rendered = true
                    failed = false
                }
                "height" -> {
                    val next = value.toDoubleOrNull()?.toInt() ?: 0
                    // ResizeObserver feedback-loop guard (web parity).
                    if (next > 0 && abs(next - heightCss) > 1) heightCss = next
                }
                // Keep the last good diagram; only a block that never
                // rendered falls back to source.
                "invalid" -> if (!rendered) failed = true
            }
        }
    }

    // A fresh source gets a fresh chance even if the previous one
    // failed (a failed block has released its WebView; a new one is
    // created below and reports `ready` again).
    LaunchedEffect(trimmed) { failed = false }

    LaunchedEffect(webView, ready, trimmed, dark, isStreaming) {
        val view = webView ?: return@LaunchedEffect
        if (!ready) return@LaunchedEffect
        if (isStreaming) delay(200)
        // Dedupe on (theme, source): the effect also restarts when
        // streaming ends, and re-rendering an identical diagram is waste.
        val key = "$dark\n$trimmed"
        if (lastRender[0] == key) return@LaunchedEffect
        lastRender[0] = key
        // JSON-encode the source so it lands in the page as one string
        // literal regardless of quotes/newlines/backslashes in the
        // diagram text.
        view.evaluateJavascript("window.argusRender(${jsStringLiteral(trimmed)}, $dark)", null)
    }

    if (failed) {
        CodeBlock(trimmed, modifier)
        return
    }

    BlockChrome(
        showSource = showSource,
        onToggle = { showSource = !showSource },
        copyText = trimmed,
        modifier = modifier,
    ) {
        if (showSource || !rendered) {
            CodeBlock(trimmed, Modifier.fillMaxWidth().padding(8.dp))
        }
        val visible = rendered && !showSource
        AndroidView(
            factory = { ctx ->
                createMermaidWebView(ctx, bridge) {
                    // Renderer process died: the view must go; the block
                    // degrades to source like any other failure.
                    failed = true
                }.also { webView = it }
            },
            // Kept alive (1dp) while hidden, so Source → Rendered is
            // instant and needs no re-render, and so the first render can
            // land while the code block is showing.
            modifier = Modifier
                .fillMaxWidth()
                .height(if (visible) maxOf(MIN_BLOCK_HEIGHT_DP, heightCss).dp else 1.dp),
            onRelease = { view ->
                webView = null
                ready = false
                rendered = false
                lastRender[0] = ""
                view.removeJavascriptInterface(MERMAID_BRIDGE)
                view.destroy()
            },
        )
    }
}

/**
 * A ```html fenced block: rendered in a sandboxed WebView by default,
 * with a Source toggle — the counterpart of the web's HtmlPreview chat
 * path (`allow-scripts` WITHOUT `allow-same-origin`).
 *
 * Scripts run (CDN chart libs etc.) but the document is loaded with a
 * null base URL, i.e. an opaque `about:blank` origin, with file and
 * content-provider access off and every navigation cancelled — it can
 * reach the network (that is how CDN libraries load, the point of the
 * path) but nothing of the app. A `color-scheme` hint follows the app
 * theme so UA defaults flip with it; authored CSS still wins.
 *
 * Height is probed from the page's own `scrollHeight` after load, and
 * re-probed a few times while late scripts (charts) lay out; loads are
 * content-deduped and debounced while streaming so token churn cannot
 * thrash the WebView.
 */
@Composable
fun HtmlBlock(
    html: String,
    modifier: Modifier = Modifier,
    isStreaming: Boolean = false,
) {
    val trimmed = html.trimEnd('\n')
    val dark = argusPalette.isDark
    var showSource by remember { mutableStateOf(false) }
    var heightCss by remember { mutableIntStateOf(0) }
    var crashed by remember { mutableStateOf(false) }
    var pageLoads by remember { mutableIntStateOf(0) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    val lastLoad = remember { arrayOf("") }

    LaunchedEffect(webView, trimmed, dark, isStreaming) {
        val view = webView ?: return@LaunchedEffect
        if (isStreaming) delay(250)
        val key = "$dark\n$trimmed"
        if (lastLoad[0] == key) return@LaunchedEffect
        lastLoad[0] = key
        view.loadDataWithBaseURL(null, prepareHtmlDocument(trimmed, dark), "text/html", "utf-8", null)
    }

    // Measure after each load, then again as late layout settles. The
    // evaluateJavascript callback lands on the main thread.
    LaunchedEffect(webView, pageLoads) {
        val view = webView ?: return@LaunchedEffect
        if (pageLoads == 0) return@LaunchedEffect
        for (wait in longArrayOf(0L, 250L, 1000L, 2500L)) {
            delay(wait)
            view.evaluateJavascript(HEIGHT_PROBE) { result ->
                val next = result?.trim()?.trim('"')?.toDoubleOrNull()?.toInt() ?: 0
                if (next > 0 && abs(next - heightCss) > 1) heightCss = next
            }
        }
    }

    if (crashed) {
        CodeBlock(trimmed, modifier)
        return
    }

    BlockChrome(
        showSource = showSource,
        onToggle = { showSource = !showSource },
        copyText = trimmed,
        modifier = modifier,
    ) {
        if (showSource) {
            CodeBlock(trimmed, Modifier.fillMaxWidth().padding(8.dp))
        }
        AndroidView(
            factory = { ctx ->
                createHtmlWebView(
                    ctx,
                    onPageFinished = { pageLoads += 1 },
                    onGone = { crashed = true },
                ).also { webView = it }
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(if (showSource) 1.dp else maxOf(MIN_BLOCK_HEIGHT_DP, heightCss).dp),
            onRelease = { view ->
                webView = null
                lastLoad[0] = ""
                view.destroy()
            },
        )
    }
}

// MARK: - WebView construction

/**
 * Receives the host page's `post(kind, value)` calls. JavaScript
 * interface methods run on a WebView-owned background thread, so every
 * message hops to the main looper before touching Compose state.
 *
 * `internal`, not `private`: the bridge is enumerated reflectively by the
 * WebView, which needs a public class with public annotated methods.
 */
internal class MermaidBridge(
    private val main: Handler,
    private val onMessage: (kind: String, value: String) -> Unit,
) {
    @JavascriptInterface
    fun post(kind: String, value: String) {
        main.post { onMessage(kind, value) }
    }
}

/**
 * The mermaid host: loads the bundled page ONCE (a file:///android_asset/
 * URL whose `<script src="mermaid.min.js">` resolves next to it), then
 * source + theme are pushed in through `window.argusRender` — a theme
 * flip redraws without re-parsing the 3 MB script. Every navigation the
 * page might attempt is cancelled, so nothing in a diagram can lead
 * anywhere. File-system access stays off: `android_asset` URLs are
 * served regardless of that setting.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun createMermaidWebView(
    context: Context,
    bridge: MermaidBridge,
    onGone: () -> Unit,
): WebView = WebView(context).apply {
    settings.javaScriptEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    setBackgroundColor(android.graphics.Color.TRANSPARENT)
    isVerticalScrollBarEnabled = false
    isHorizontalScrollBarEnabled = false
    overScrollMode = View.OVER_SCROLL_NEVER
    webViewClient = object : WebViewClient() {
        /** Allow only the initial asset load; page-initiated navigations never reach here as anything but cancelled. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onGone()
            return true
        }
    }
    addJavascriptInterface(bridge, MERMAID_BRIDGE)
    loadUrl(MERMAID_PAGE)
}

/**
 * The html host: an opaque-origin document (null base URL) with scripts
 * on and everything else off. `shouldOverrideUrlLoading` returning true
 * for every request cancels link clicks, `location` changes and form
 * submits alike; `loadDataWithBaseURL` itself does not route through it.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun createHtmlWebView(
    context: Context,
    onPageFinished: () -> Unit,
    onGone: () -> Unit,
): WebView = WebView(context).apply {
    settings.javaScriptEnabled = true
    settings.allowFileAccess = false
    settings.allowContentAccess = false
    settings.setGeolocationEnabled(false)
    setBackgroundColor(android.graphics.Color.TRANSPARENT)
    isVerticalScrollBarEnabled = false
    overScrollMode = View.OVER_SCROLL_NEVER
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun onPageFinished(view: WebView, url: String?) {
            onPageFinished()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onGone()
            return true
        }
    }
}

/** Self-measure: the larger of the two scrollHeights, as the web's HEIGHT_BOOTSTRAP does. */
private const val HEIGHT_PROBE =
    "(function(){var d=document;return Math.max(d.documentElement?d.documentElement.scrollHeight:0,d.body?d.body.scrollHeight:0)})()"

private val headTagPattern = Regex("<head[^>]*>", RegexOption.IGNORE_CASE)
private val htmlTagPattern = Regex("<html[^>]*>", RegexOption.IGNORE_CASE)

/**
 * Inject a viewport pin plus a colour-scheme hint, mirroring the web's
 * `prepareDocument` and the iOS `HtmlWebView.prepareDocument`. The
 * viewport meta only takes effect if a wide viewport is ever enabled on
 * the WebView (it is not — the default lays out at the view's dp width),
 * but it keeps the document identical across the three clients.
 */
internal fun prepareHtmlDocument(content: String, dark: Boolean): String {
    val scheme = if (dark) "dark" else "light"
    val head = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
        "<meta name=\"color-scheme\" content=\"$scheme\">" +
        "<style>:root{color-scheme:$scheme}</style>"
    headTagPattern.find(content)?.let { match ->
        return content.substring(0, match.range.last + 1) + head + content.substring(match.range.last + 1)
    }
    htmlTagPattern.find(content)?.let { match ->
        return content.substring(0, match.range.last + 1) + "<head>" + head + "</head>" +
            content.substring(match.range.last + 1)
    }
    return "<!DOCTYPE html><html><head>$head</head><body>$content</body></html>"
}

/**
 * A JavaScript string literal for [value]: JSON escaping plus the two
 * line separators JSON permits raw but JavaScript source does not, and
 * `<` escaped so the literal can never form a `</script>`. Hand-rolled:
 * it is a dozen lines, and it keeps the escaping rules (which are
 * JavaScript's, not JSON's) in one visible place.
 */
internal fun jsStringLiteral(value: String): String {
    val out = StringBuilder(value.length + 16).append('"')
    for (ch in value) {
        when (ch) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            '\u2028' -> out.append("\\u2028")
            '\u2029' -> out.append("\\u2029")
            '<' -> out.append("\\u003c")
            else -> if (ch < ' ') {
                out.append("\\u").append(ch.code.toString(16).padStart(4, '0'))
            } else {
                out.append(ch)
            }
        }
    }
    return out.append('"').toString()
}

// MARK: - Chrome

/**
 * The shared frame: a Rendered/Source toggle + copy in a header row over
 * a divider, on `surface0` with a hairline border and 8dp corners — the
 * iOS block chrome. Text-only actions: the core Material icon set ships
 * no code/eye/copy glyphs and the icon-extended artifact is not a
 * dependency, so labels carry the affordance.
 */
@Composable
private fun BlockChrome(
    showSource: Boolean,
    onToggle: () -> Unit,
    copyText: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val palette = argusPalette
    val border = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)
    val shape = RoundedCornerShape(8.dp)
    Column(
        modifier
            .clip(shape)
            .background(palette.surface0)
            .border(1.dp, border, shape),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChromeAction(label = if (showSource) "Rendered" else "Source", onClick = onToggle)
            CopyAction(text = copyText)
        }
        HorizontalDivider(color = border)
        content()
    }
}

@Composable
private fun ChromeAction(label: String, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier.height(28.dp),
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
    ) {
        Text(label, style = MaterialTheme.typography.labelSmall)
    }
}

/** Copy-to-clipboard that reads "Copied" for ~1.5 s — the iOS CopyButton. */
@Composable
private fun CopyAction(text: String) {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    ChromeAction(label = if (copied) "Copied" else "Copy") {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        clipboard?.setPrimaryClip(ClipData.newPlainText("code", text))
        copied = true
    }
}

/**
 * The raw source of a renderable fence (and the fallback when it can't
 * render): horizontally-scrolling monospace on a layered surface —
 * the iOS `CodeBlock`. Deliberately unhighlighted: the transcript does
 * not syntax-highlight code on any client; that is the file viewer's job.
 */
@Composable
internal fun CodeBlock(code: String, modifier: Modifier = Modifier) {
    val palette = argusPalette
    Box(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(palette.surface1)
            .horizontalScroll(rememberScrollState()),
    ) {
        SelectionContainer {
            Text(
                text = code,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                lineHeight = 19.sp,
                softWrap = false,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp),
            )
        }
    }
}
