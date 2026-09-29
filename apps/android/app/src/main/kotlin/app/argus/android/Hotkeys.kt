package app.argus.android

import android.view.KeyEvent

/**
 * The app's hardware-keyboard bindings, in one table — the Android
 * mirror of `apps/web/src/lib/hotkeys.ts` and
 * `apps/ios/Argus/Sources/Hotkeys.swift`. Keep the three in step: a
 * chord that exists on one client and not the others is exactly the
 * asymmetry this file exists to prevent.
 *
 * Two things read it: [Hotkeys.match], which turns a raw key event into
 * a binding, and the shortcuts sheet, which renders the chord and label.
 * Dispatch takes a [HotkeyBinding] rather than a bare key so a binding
 * cannot ship without appearing in the Ctrl+/ list.
 *
 * Every binding is **Ctrl-only** here. Android hardware keyboards carry
 * Ctrl; Meta (the ⌘/Win key) is claimed by the system for launcher
 * shortcuts and is deliberately not matched. There is no terminal pane
 * yet, so no readline deferral is needed — when the terminal lands,
 * Ctrl+K / Ctrl+P / Ctrl+D / Ctrl+B must reach the PTY while it has
 * focus, exactly as the web defers them.
 *
 * `scope` says WHERE the binding is live, which is a property of the
 * dispatch point: `GLOBAL` bindings are handled by [AppModel] from the
 * activity's key path and fire on any screen; `SESSION` bindings are
 * forwarded to whatever session screen registered itself and are inert
 * on the list.
 */
data class HotkeyBinding(
    val id: String,
    /** The key, lowercased; `'\r'` is Enter. */
    val key: Char,
    /** How the chord is written in the UI. */
    val chord: String,
    /** What pressing it does, phrased as an action. */
    val label: String,
    val scope: HotkeyScope,
)

enum class HotkeyScope { GLOBAL, SESSION }

/** A key owned by whichever control has focus, listed for the sheet only. */
data class LocalKey(val chord: String, val label: String)

data class LocalKeyGroup(val title: String, val keys: List<LocalKey>)

object Hotkeys {
    val paletteSession = HotkeyBinding(
        "paletteSession", 'p', "Ctrl+P", "Switch to a session by name", HotkeyScope.GLOBAL,
    )
    val paletteContent = HotkeyBinding(
        "paletteContent", 'k', "Ctrl+K", "Search what was said, across every session", HotkeyScope.GLOBAL,
    )
    val toggleSidebar = HotkeyBinding(
        "toggleSidebar", 'b', "Ctrl+B", "Show or hide the session list (tablet)", HotkeyScope.GLOBAL,
    )
    val shortcutsHelp = HotkeyBinding(
        "shortcutsHelp", '/', "Ctrl+/", "Open this list", HotkeyScope.GLOBAL,
    )
    val archiveSession = HotkeyBinding(
        "archiveSession", 'd', "Ctrl+D", "Archive the open session — press again to restore", HotkeyScope.SESSION,
    )
    val cancelTurn = HotkeyBinding(
        "cancelTurn", '.', "Ctrl+.", "Stop the running turn", HotkeyScope.SESSION,
    )
    /** iOS parity (⌘⏎); the web sends on plain Enter. Handled by the composer itself. */
    val sendPrompt = HotkeyBinding(
        "sendPrompt", '\r', "Ctrl+⏎", "Send — or queue, while a turn is running", HotkeyScope.SESSION,
    )

    val all: List<HotkeyBinding> = listOf(
        paletteSession, paletteContent, toggleSidebar, shortcutsHelp,
        archiveSession, cancelTurn, sendPrompt,
    ).also { list ->
        // Two bindings on one key is a silent failure — both fire, and
        // the symptom is "the shortcut does something weird sometimes".
        check(list.map { it.key }.toSet().size == list.size) { "[hotkeys] two bindings claim one key" }
    }

    /**
     * Keys owned by whichever control has focus, rather than by a
     * binding. Listed so the Ctrl+/ sheet is a complete answer to "what
     * can I press" — but deliberately NOT in [all], because nothing
     * dispatches them through [match] and putting them there would imply
     * otherwise.
     */
    val localKeys: List<LocalKeyGroup> = listOf(
        LocalKeyGroup(
            "Composer",
            listOf(
                LocalKey("⏎", "Send — or queue, while a turn is running (hardware keyboard)"),
                LocalKey("⇧⏎", "New line"),
                LocalKey("esc", "Leave the composer"),
            ),
        ),
        LocalKeyGroup("File preview", listOf(LocalKey("esc", "Close the preview"))),
        LocalKeyGroup(
            "Command palette",
            listOf(
                LocalKey("↑ ↓", "Move through results"),
                LocalKey("⏎", "Open the selected result"),
                LocalKey("tab", "Run the same query against the other index"),
                LocalKey("esc", "Close"),
            ),
        ),
    )

    /**
     * The binding a hardware key-down names, or null. Ctrl plus exactly
     * the key — a shifted or alt'd variant passes through so Ctrl+Shift+P
     * stays bindable by the system or a future chord.
     */
    fun match(event: KeyEvent): HotkeyBinding? {
        if (event.action != KeyEvent.ACTION_DOWN) return null
        if (!event.isCtrlPressed || event.isShiftPressed || event.isAltPressed || event.isMetaPressed) return null
        val key = when (event.keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> '\r'
            KeyEvent.KEYCODE_SLASH -> '/'
            KeyEvent.KEYCODE_PERIOD -> '.'
            in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> ('a' + (event.keyCode - KeyEvent.KEYCODE_A))
            else -> return null
        }
        return all.firstOrNull { it.key == key }
    }
}
