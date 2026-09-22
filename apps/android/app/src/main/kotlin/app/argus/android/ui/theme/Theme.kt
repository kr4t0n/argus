package app.argus.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// Argus's semantic colours on top of Material 3 — the agent brand colours
// and the amber/emerald/red status grammar from the web sidebar, plus the
// layered greys mirroring the web's surface-0/1/2 tokens EXACTLY
// (index.css: light 97.3/92/87%, dark 4/9/15% lightness). Port of the
// Color extensions in apps/ios/Argus/Sources/Views/Components.swift.

@Immutable
data class ArgusPalette(
    val surface0: Color,
    val surface1: Color,
    val surface2: Color,
    /** Inline-code accent (`.markdown code`): red-700 light / blue-200 dark. */
    val codeInlineFg: Color,
    /** Markdown link colour (sky-600 / sky-400). */
    val mdLink: Color,
    /** Amber (agent tool tint): amber-600 / amber-400. */
    val toolAmber: Color,
    val agentClaude: Color,
    val agentCodex: Color,
    val agentCursor: Color,
    val agentCustom: Color,
    /** Sidebar dot grammar: amber = running, emerald = done + unread, red = failed + unread. */
    val statusRunning: Color,
    val statusDone: Color,
    val statusFailed: Color,
    val diffAddBg: Color,
    val diffAddFg: Color,
    val diffRemoveBg: Color,
    val diffRemoveFg: Color,
    val diffHunkFg: Color,
    val isDark: Boolean,
)

private fun rgb(hex: Long): Color = Color(0xFF000000L or hex)

val LightArgusPalette = ArgusPalette(
    surface0 = rgb(0xF8F8F8),
    surface1 = rgb(0xEBEBEB),
    surface2 = rgb(0xDEDEDE),
    codeInlineFg = rgb(0xB91C1C),
    mdLink = rgb(0x0284C7),
    toolAmber = rgb(0xD97706),
    agentClaude = rgb(0xFB923C),
    agentCodex = rgb(0x10B981),
    agentCursor = rgb(0x38BDF8),
    agentCustom = rgb(0xA3A3A3),
    statusRunning = rgb(0xF59E0B),
    statusDone = rgb(0x10B981),
    statusFailed = rgb(0xEF4444),
    diffAddBg = Color(0x2210B981),
    diffAddFg = rgb(0x047857),
    diffRemoveBg = Color(0x22EF4444),
    diffRemoveFg = rgb(0xB91C1C),
    diffHunkFg = rgb(0x0284C7),
    isDark = false,
)

val DarkArgusPalette = ArgusPalette(
    surface0 = rgb(0x0A0A0A),
    surface1 = rgb(0x171717),
    surface2 = rgb(0x262626),
    codeInlineFg = rgb(0xBFDBFE),
    mdLink = rgb(0x38BDF8),
    toolAmber = rgb(0xFBBF24),
    agentClaude = rgb(0xFB923C),
    agentCodex = rgb(0x10B981),
    agentCursor = rgb(0x38BDF8),
    agentCustom = rgb(0xA3A3A3),
    statusRunning = rgb(0xFBBF24),
    statusDone = rgb(0x34D399),
    statusFailed = rgb(0xF87171),
    diffAddBg = Color(0x2A34D399),
    diffAddFg = rgb(0x6EE7B7),
    diffRemoveBg = Color(0x2AF87171),
    diffRemoveFg = rgb(0xFCA5A5),
    diffHunkFg = rgb(0x7DD3FC),
    isDark = true,
)

val LocalArgusPalette = staticCompositionLocalOf { LightArgusPalette }

/** `LocalArgusPalette.current`, for call sites that read as prose. */
val argusPalette: ArgusPalette
    @Composable get() = LocalArgusPalette.current

// The Material schemes are pinned to the web's NEUTRAL greys, not
// Material's default purple-tinted ones: every text and hairline colour
// Compose components pick up (onSurfaceVariant, outlineVariant, the
// surfaceContainer* levels that sheets and menus paint) is a surface
// token or a Tailwind neutral, so a sheet, a menu and the list all sit
// on the same three greys the web and iOS use.
private val LightScheme: ColorScheme = lightColorScheme(
    background = LightArgusPalette.surface0,
    onBackground = rgb(0x171717),
    surface = LightArgusPalette.surface0,
    onSurface = rgb(0x171717),
    surfaceVariant = LightArgusPalette.surface1,
    onSurfaceVariant = rgb(0x737373),
    surfaceContainerLowest = rgb(0xFFFFFF),
    surfaceContainerLow = rgb(0xFFFFFF),
    surfaceContainer = LightArgusPalette.surface1,
    surfaceContainerHigh = LightArgusPalette.surface1,
    surfaceContainerHighest = LightArgusPalette.surface2,
    outline = rgb(0xA3A3A3),
    outlineVariant = rgb(0xE8E8E8),
    primary = rgb(0x171717),
    onPrimary = rgb(0xFAFAFA),
    primaryContainer = LightArgusPalette.surface2,
    onPrimaryContainer = rgb(0x171717),
    secondaryContainer = LightArgusPalette.surface2,
    onSecondaryContainer = rgb(0x171717),
    error = rgb(0xDC2626),
)

private val DarkScheme: ColorScheme = darkColorScheme(
    background = DarkArgusPalette.surface0,
    onBackground = rgb(0xFAFAFA),
    surface = DarkArgusPalette.surface0,
    onSurface = rgb(0xFAFAFA),
    surfaceVariant = DarkArgusPalette.surface1,
    onSurfaceVariant = rgb(0xA3A3A3),
    surfaceContainerLowest = DarkArgusPalette.surface0,
    surfaceContainerLow = DarkArgusPalette.surface1,
    surfaceContainer = DarkArgusPalette.surface1,
    surfaceContainerHigh = DarkArgusPalette.surface2,
    surfaceContainerHighest = DarkArgusPalette.surface2,
    outline = rgb(0x525252),
    outlineVariant = DarkArgusPalette.surface2,
    primary = rgb(0xFAFAFA),
    onPrimary = rgb(0x171717),
    primaryContainer = DarkArgusPalette.surface2,
    onPrimaryContainer = rgb(0xFAFAFA),
    secondaryContainer = DarkArgusPalette.surface2,
    onSecondaryContainer = rgb(0xFAFAFA),
    error = rgb(0xF87171),
)

@Composable
fun ArgusTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val palette = if (darkTheme) DarkArgusPalette else LightArgusPalette
    CompositionLocalProvider(LocalArgusPalette provides palette) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkScheme else LightScheme,
            content = content,
        )
    }
}
