import SwiftUI

/// The app's keyboard bindings, in one table — the iOS mirror of
/// `apps/web/src/lib/hotkeys.ts`. Keep the two in step: a chord that
/// exists on one client and not the other is exactly the asymmetry this
/// file exists to prevent.
///
/// Two things read it: the `hotkey(_:)` call sites, which need the key,
/// and `ShortcutsHelpSheet`, which renders the chord and label. Call
/// sites take a `HotkeyBinding` rather than a bare key so a binding
/// cannot ship without appearing in the ⌘/ list.
///
/// Every binding is ⌘-only. The web also accepts the Ctrl form and
/// defers it while the terminal has focus (readline and tmux own
/// Ctrl+K / Ctrl+P / Ctrl+D / Ctrl+B); here the Ctrl form is simply
/// never bound, so a hardware keyboard's Ctrl chords reach SwiftTerm
/// untouched. ⌘ is never forwarded to a PTY, so the bindings work from
/// inside the terminal pane as well.
///
/// `scope` says WHERE the binding is live, which is a property of the
/// mount point: `global` bindings are scene commands (`ArgusCommands`)
/// and fire from any pane; `session` bindings sit on views inside
/// `SessionView` and are inert on the machine and account panes.
struct HotkeyBinding: Identifiable, Sendable {
    enum Scope: Sendable {
        case global
        case session
    }

    let id: String
    /// The key as `KeyEquivalent` spells it. `"\r"` is Return.
    let key: Character
    /// How the chord is written in the UI.
    let chord: String
    /// What pressing it does, phrased as an action.
    let label: String
    let scope: Scope

    var keyEquivalent: KeyEquivalent {
        key == "\r" ? .return : KeyEquivalent(key)
    }
}

enum Hotkeys {
    static let paletteSession = HotkeyBinding(
        id: "paletteSession", key: "p", chord: "⌘P",
        label: "Switch to a session by name", scope: .global
    )
    static let paletteContent = HotkeyBinding(
        id: "paletteContent", key: "k", chord: "⌘K",
        label: "Search what was said, across every session", scope: .global
    )
    static let toggleSidebar = HotkeyBinding(
        id: "toggleSidebar", key: "b", chord: "⌘B",
        label: "Show or hide the sidebar (iPad)", scope: .global
    )
    static let shortcutsHelp = HotkeyBinding(
        id: "shortcutsHelp", key: "/", chord: "⌘/",
        label: "Open this list", scope: .global
    )
    static let archiveSession = HotkeyBinding(
        id: "archiveSession", key: "d", chord: "⌘D",
        label: "Archive the open session — press again to restore", scope: .session
    )
    static let cancelTurn = HotkeyBinding(
        id: "cancelTurn", key: ".", chord: "⌘.",
        label: "Stop the running turn", scope: .session
    )
    /// Not on the web, where plain Enter sends; kept because it predates
    /// this table and a Magic Keyboard user may already lean on it.
    static let sendPrompt = HotkeyBinding(
        id: "sendPrompt", key: "\r", chord: "⌘⏎",
        label: "Send — or queue, while a turn is running", scope: .session
    )

    static let all: [HotkeyBinding] = {
        let list = [
            paletteSession, paletteContent, toggleSidebar, shortcutsHelp,
            archiveSession, cancelTurn, sendPrompt,
        ]
        // Two bindings on one key is a silent failure — both fire, in
        // hierarchy order, and the symptom is "the shortcut does
        // something weird sometimes". Debug builds catch it at first use.
        assert(Set(list.map(\.key)).count == list.count, "[hotkeys] two bindings claim one key")
        return list
    }()
}

/// Keys owned by whichever view has focus, rather than by a
/// `HotkeyBinding`. Listed so the ⌘/ sheet is a complete answer to
/// "what can I press" — but deliberately NOT in `Hotkeys`, because
/// nothing registers them through `hotkey(_:)` and putting them there
/// would imply otherwise. The terminal group is the one users most need
/// told: those keys are *not* Argus bindings precisely because the Ctrl
/// form is never claimed.
struct LocalKeyGroup: Identifiable, Sendable {
    struct Key: Identifiable, Sendable {
        let chord: String
        let label: String
        var id: String { chord + label }
    }

    let title: String
    let keys: [Key]
    var id: String { title }
}

extension Hotkeys {
    static let localKeys: [LocalKeyGroup] = [
        LocalKeyGroup(title: "Composer", keys: [
            .init(chord: "⏎", label: "Send — or queue, while a turn is running (hardware keyboard)"),
            .init(chord: "⇧⏎", label: "New line"),
            .init(chord: "esc", label: "Leave the composer"),
        ]),
        LocalKeyGroup(title: "File preview", keys: [
            .init(chord: "esc", label: "Close the preview"),
        ]),
        LocalKeyGroup(title: "Command palette", keys: [
            .init(chord: "↑ ↓", label: "Move through results"),
            .init(chord: "⏎", label: "Open the selected result"),
            .init(chord: "tab", label: "Run the same query against the other index"),
            .init(chord: "esc", label: "Close"),
        ]),
        LocalKeyGroup(title: "Terminal", keys: [
            .init(chord: "ctrl+D", label: "EOF — reaches the shell, not Argus"),
            .init(chord: "ctrl+K", label: "Kill line — reaches the shell"),
            .init(chord: "ctrl+B", label: "tmux prefix — reaches the shell"),
        ]),
    ]
}

extension View {
    /// ⌘ + the binding's key. The only way a view should claim a
    /// shortcut — a raw `keyboardShortcut` call site is a binding the
    /// ⌘/ sheet can never render.
    func hotkey(_ binding: HotkeyBinding) -> some View {
        keyboardShortcut(binding.keyEquivalent, modifiers: .command)
    }
}
