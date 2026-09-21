import SwiftUI

/// The ⌘/ shortcuts list — the web's ShortcutsHelp.
///
/// It RENDERS `Hotkeys` rather than restating it, so a binding cannot
/// ship undocumented: `hotkey(_:)` takes a `HotkeyBinding`, and every
/// `HotkeyBinding` lives in the table this reads. The context-local
/// keys are appended because a user asking "what can I press" does not
/// care which layer owns the handler.
///
/// Entry points: ⌘/ itself, and the keyboard glyph in the sidebar's
/// account row — the one affordance that does not require already
/// knowing a binding, which is what breaks the circle for a new user.
/// Rides `AppModel.paletteMode` like the palette, so ⌘P while this is
/// up is a switch, not a second sheet.
struct ShortcutsHelpSheet: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
            List {
                Section("Anywhere") {
                    ForEach(Hotkeys.all.filter { $0.scope == .global }) { binding in
                        row(binding.label, binding.chord)
                    }
                }
                Section("In a session") {
                    ForEach(Hotkeys.all.filter { $0.scope == .session }) { binding in
                        row(binding.label, binding.chord)
                    }
                }
                ForEach(Hotkeys.localKeys) { group in
                    Section(group.title) {
                        ForEach(group.keys) { key in
                            row(key.label, key.chord)
                        }
                    }
                }
                Section {
                    Text("Shortcuts need a hardware keyboard. The ctrl form of a key is never bound, so it reaches the terminal's shell.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Keyboard shortcuts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { app.closePalette() }
                        .keyboardShortcut(.cancelAction)
                }
            }
        }
    }

    private func row(_ label: String, _ chord: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.primary)
            Spacer(minLength: 12)
            KeycapView(chord)
        }
    }
}

/// The web's `<Kbd>`: a chord in a small monospaced keycap.
struct KeycapView: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.surface2, in: RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color(.separator)))
    }
}
