package app.argus.android.ui.markdown

import android.content.Context
import android.graphics.Typeface
import android.text.method.LinkMovementMethod
import android.text.util.Linkify
import android.util.TypedValue
import android.widget.TextView
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.argus.android.ui.theme.argusPalette
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.LinkResolver
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.ext.latex.JLatexMathPlugin
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.tasklist.TaskListPlugin
import io.noties.markwon.inlineparser.MarkwonInlineParserPlugin
import io.noties.markwon.linkify.LinkifyPlugin

/**
 * One Markdown segment of an assistant answer, rendered by Markwon into a
 * `TextView` hosted in [AndroidView] — the Android counterpart of the
 * `Markdown(text)` leaves in apps/ios/Argus/Sources/Views/MarkdownRender.swift.
 *
 * The Markwon instance is built ONCE per (context, resolved style) and
 * remembered: the plugin chain (tables, strikethrough, task lists, LaTeX
 * via JLatexMath, linkify) is not cheap to assemble and every answer on
 * screen would otherwise rebuild it per recomposition. A theme flip
 * changes the style key and rebuilds — that is the only time.
 *
 * Styling ports the web's `.markdown` body (apps/web/src/index.css) the
 * way iOS does: inline code is a chip on `surface2` at half alpha with
 * the `codeInlineFg` accent; links are `mdLink` and NOT underlined at
 * rest (the web underlines on hover only); fenced code is monospace on
 * `surface1`; headings carry no size hierarchy beyond a very modest
 * 1.2 / 1.07 / 1.0 — the web's headings are just semibold at body size.
 * Body ≈ the web's text-sm (14px), a touch larger for mobile (15sp).
 *
 * Math: JLatexMath renders `$$…$$` blocks and — with inlines enabled —
 * `$$…$$` inline spans. Single-dollar inline math is NOT Markwon syntax;
 * the caller rewrites it first (`MarkwonMath.rewriteInline` in :core).
 * Inline LaTeX requires Markwon's own inline parser plugin to be
 * registered (`JLatexMathPlugin` `require()`s it and throws at build
 * time otherwise) — hence `MarkwonInlineParserPlugin` in the chain.
 *
 * `onLink` receives the RAW link destination (Markwon does not
 * percent-encode or resolve it), so `src/foo.go:123` arrives verbatim
 * for `AnswerView`'s citation routing.
 */
@Composable
fun MarkwonText(
    markdown: String,
    modifier: Modifier = Modifier,
    onLink: ((String) -> Unit)? = null,
) {
    val context = LocalContext.current
    val palette = argusPalette
    val scheme = MaterialTheme.colorScheme
    val contentColor = LocalContentColor.current
    val density = LocalDensity.current

    val textColor = if (contentColor == Color.Unspecified) scheme.onBackground else contentColor
    val secondary = scheme.onSurfaceVariant
    // Derived eagerly: a handful of colour/px conversions per
    // recomposition is cheaper than remembering them, and the data-class
    // equality of the result is what keys the Markwon rebuild below.
    val style = with(density) {
        MarkwonStyle(
            textColor = textColor.toArgb(),
            secondaryColor = secondary.toArgb(),
            linkColor = palette.mdLink.toArgb(),
            codeInlineFg = palette.codeInlineFg.toArgb(),
            codeInlineBg = palette.surface2.copy(alpha = 0.5f).toArgb(),
            codeBlockBg = palette.surface1.toArgb(),
            quoteBar = textColor.copy(alpha = 0.25f).toArgb(),
            // Dimmed border (web `border-default`): the iOS table border
            // pick, light 0xE8E8E8 / dark 0x1F1F1F.
            tableBorder = (if (palette.isDark) Color(0xFF1F1F1F) else Color(0xFFE8E8E8)).toArgb(),
            tableOddRowBg = palette.surface1.copy(alpha = 0.3f).toArgb(),
            taskCheckedFill = palette.statusDone.toArgb(),
            taskCheckMark = scheme.onPrimary.toArgb(),
            bodyPx = 15.sp.toPx(),
            // 0.85em of body ≈ 13sp — the web's text-xs inline / text-sm block.
            codePx = 13.sp.roundToPx(),
            blockMarginPx = 20.dp.roundToPx(),
            codeBlockMarginPx = 14.dp.roundToPx(),
            tableCellPaddingPx = 8.dp.roundToPx(),
            hairlinePx = 1.dp.roundToPx().coerceAtLeast(1),
        )
    }

    // The resolver reads the LATEST callback at click time, so a new
    // lambda identity from the caller never forces a Markwon rebuild.
    val currentOnLink = rememberUpdatedState(onLink)
    val markwon = remember(context, style) { buildMarkwon(context, style, currentOnLink) }

    AndroidView(
        factory = { ctx ->
            TextView(ctx).apply {
                // Order matters: setTextIsSelectable installs an
                // ArrowKeyMovementMethod; LinkMovementMethod set AFTER it
                // keeps arbitrary selection (it reports canSelectArbitrarily)
                // and makes link spans tappable.
                setTextIsSelectable(true)
                movementMethod = LinkMovementMethod.getInstance()
                setLineSpacing(0f, 1.2f)
            }
        },
        modifier = modifier,
        update = { view ->
            view.setTextColor(style.textColor)
            view.setTextSize(TypedValue.COMPLEX_UNIT_PX, style.bodyPx)
            // Re-parse only when the text or the style actually changed:
            // `update` re-runs on every recomposition (the Markwon
            // instance is not a stable type), and a streaming transcript
            // recomposes constantly.
            val key = markdown to style
            if (view.tag != key) {
                view.tag = key
                markwon.setMarkdown(view, markdown)
            }
        },
    )
}

/** Everything the Markwon theme needs, as Android ints / px — the rebuild key. */
@Immutable
private data class MarkwonStyle(
    val textColor: Int,
    val secondaryColor: Int,
    val linkColor: Int,
    val codeInlineFg: Int,
    val codeInlineBg: Int,
    val codeBlockBg: Int,
    val quoteBar: Int,
    val tableBorder: Int,
    val tableOddRowBg: Int,
    val taskCheckedFill: Int,
    val taskCheckMark: Int,
    val bodyPx: Float,
    val codePx: Int,
    val blockMarginPx: Int,
    val codeBlockMarginPx: Int,
    val tableCellPaddingPx: Int,
    val hairlinePx: Int,
)

private fun buildMarkwon(
    context: Context,
    style: MarkwonStyle,
    onLink: State<((String) -> Unit)?>,
): Markwon = Markwon.builder(context)
    // Markwon's inline parser replaces commonmark's; JLatexMath inlines
    // hang their `$$…$$` processor off it.
    .usePlugin(MarkwonInlineParserPlugin.create())
    .usePlugin(
        TablePlugin.create(
            TablePlugin.ThemeConfigure { table ->
                // Built from a blank TableTheme.Builder, so padding and
                // border width have to be set explicitly (their unset
                // values are 0 / the paint's stroke width).
                table.tableCellPadding(style.tableCellPaddingPx)
                table.tableBorderWidth(style.hairlinePx)
                table.tableBorderColor(style.tableBorder)
                // Subtle zebra rows (web `surface1` at 30%), no header fill.
                table.tableOddRowBackgroundColor(style.tableOddRowBg)
                table.tableEvenRowBackgroundColor(0)
                table.tableHeaderRowBackgroundColor(0)
            },
        ),
    )
    .usePlugin(StrikethroughPlugin.create())
    .usePlugin(TaskListPlugin.create(style.taskCheckedFill, style.secondaryColor, style.taskCheckMark))
    .usePlugin(
        JLatexMathPlugin.create(
            style.bodyPx,
            JLatexMathPlugin.BuilderConfigure { latex ->
                latex.inlinesEnabled(true)
                latex.theme().textColor(style.textColor)
            },
        ),
    )
    // Bare URLs and e-mail addresses become links; phone numbers are
    // deliberately excluded — `file.go:123`-shaped citations and version
    // strings are exactly what a phone-number matcher false-positives on.
    .usePlugin(LinkifyPlugin.create(Linkify.WEB_URLS or Linkify.EMAIL_ADDRESSES))
    .usePlugin(object : AbstractMarkwonPlugin() {
        override fun configureTheme(builder: MarkwonTheme.Builder) {
            builder
                .linkColor(style.linkColor)
                .isLinkUnderlined(false)
                .codeTextColor(style.codeInlineFg)
                .codeBackgroundColor(style.codeInlineBg)
                .codeTextSize(style.codePx)
                .codeTypeface(Typeface.MONOSPACE)
                .codeBlockTextColor(style.textColor)
                .codeBlockBackgroundColor(style.codeBlockBg)
                .codeBlockTextSize(style.codePx)
                .codeBlockTypeface(Typeface.MONOSPACE)
                .codeBlockMargin(style.codeBlockMarginPx)
                // Web pl-5 list indent; markers dimmed like the iOS "•".
                .blockMargin(style.blockMarginPx)
                .listItemColor(style.secondaryColor)
                .blockQuoteColor(style.quoteBar)
                // No rule under h1/h2 — the web's headings are plain
                // semibold text, sized 18 / 16 / 15 over a 15 body.
                .headingBreakHeight(0)
                .headingTextSizeMultipliers(floatArrayOf(1.2f, 1.067f, 1f, 1f, 1f, 1f))
                .thematicBreakColor(style.tableBorder)
        }

        override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
            builder.linkResolver(
                LinkResolver { _, link ->
                    onLink.value?.invoke(link)
                },
            )
        }
    })
    .build()
