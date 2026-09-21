import SwiftUI
import ArgusKit

/// Scene-level bindings: the hotkeys that must work from any pane. On
/// iOS that means the scene's command menu rather than a view somewhere
/// in the hierarchy — a `.keyboardShortcut` on a view is inert whenever
/// that view is off screen, and the split view swaps its detail column.
/// `CommandMenu` also lists them in the iPad hold-⌘ HUD and in the menu
/// bar under Designed-for-iPad on Mac.
///
/// The actions no-op before login (`AppModel` guards on `phase`), which
/// is cheaper and more reliable than observing the phase from a
/// `Commands` body.
struct ArgusCommands: Commands {
    let app: AppModel

    var body: some Commands {
        CommandMenu("Argus") {
            Button("Switch session…") { app.togglePalette(.session) }
                .hotkey(Hotkeys.paletteSession)
            Button("Search transcripts…") { app.togglePalette(.content) }
                .hotkey(Hotkeys.paletteContent)
            Divider()
            Button("Keyboard shortcuts") { app.togglePalette(.help) }
                .hotkey(Hotkeys.shortcutsHelp)
        }
    }
}

/// The ONE sheet behind `AppModel.paletteMode`. Three overlays share a
/// single presentation so pressing another overlay's hotkey swaps the
/// content in place — two sheets would have to negotiate which of them
/// is up, and SwiftUI would present the second over the first.
struct PaletteSheet: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if app.paletteMode == .help {
            ShortcutsHelpSheet()
        } else {
            CommandPaletteSheet()
        }
    }
}

/// The ⌘P / ⌘K palette — one view, two modes (the web's CommandPalette):
///
///   ⌘P  session — switch by NAME. Ranked client-side by `SessionMatch`
///                 over the session list the app already holds, so it is
///                 instant and needs no API. Empty query lists recent
///                 live sessions, which makes switching two keystrokes.
///   ⌘K  content — search what was SAID. Server-side full text over
///                 prompts and answers, archived included, snippets
///                 highlighted.
///
/// Tab switches mode and KEEPS the query — the whole point is re-running
/// the same words against the other index. Selecting a row navigates and
/// closes. A ⌘K hit opens the session at its TAIL: the web lands on the
/// matched turn through a floating transcript window, which this
/// client's transcript engine does not model yet (see AGENTS.md).
struct CommandPaletteSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var query = ""
    @State private var cursor = 0
    @State private var hits: [SessionSearchHitDTO] = []
    @State private var loading = false
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var fieldFocused: Bool

    /// Debounce before firing a content query. Long enough that typing a
    /// word is one request, short enough to feel live. Session mode has
    /// no debounce — it never leaves the device.
    private static let debounce: Duration = .milliseconds(200)
    /// The server rejects shorter; mirrored here to avoid the round-trip.
    private static let minContentQuery = 2
    /// Rows shown in session mode, including the zero-query recents list.
    private static let sessionLimit = 12

    private var sessionMode: Bool { app.paletteMode != .content }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var ranked: [RankedSession] {
        guard sessionMode else { return [] }
        return SessionMatch.rank(
            query: query,
            candidates: app.sessionList.searchCandidates(fleet: app.fleet),
            limit: Self.sessionLimit
        )
    }

    /// Rows are keyed by session id in both modes, so navigation and the
    /// keyboard cursor are written once.
    private var rowIds: [String] {
        sessionMode ? ranked.map(\.id) : hits.map(\.sessionId)
    }

    var body: some View {
        let ranked = self.ranked
        let ids = sessionMode ? ranked.map(\.id) : hits.map(\.sessionId)
        NavigationStack {
            VStack(spacing: 0) {
                searchField
                Divider()
                resultList(ranked: ranked, ids: ids)
                // Keyboard hints only where a keyboard is plausible.
                if sizeClass == .regular {
                    footer(count: ids.count)
                }
            }
            .navigationTitle(sessionMode ? "Switch session" : "Search transcripts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { app.closePalette() }
                        .keyboardShortcut(.cancelAction)
                }
                ToolbarItem(placement: .confirmationAction) {
                    // The touch path to the other index (Tab on a keyboard).
                    Button {
                        switchMode()
                    } label: {
                        Label(
                            sessionMode ? "Search transcripts" : "Switch session",
                            systemImage: "arrow.left.arrow.right"
                        )
                    }
                }
            }
        }
        .task {
            // Focus once the sheet is in the window — a set on appear can
            // land before the field exists and be dropped silently.
            try? await Task.sleep(for: .milliseconds(50))
            fieldFocused = true
        }
        .onDisappear { searchTask?.cancel() }
        .onChange(of: query) { runContentSearch() }
        .onChange(of: app.paletteMode) {
            // Mode switch: same words, other index.
            cursor = 0
            runContentSearch()
        }
        // Ranking is synchronous, so the cursor can outlive a shrinking list.
        .onChange(of: ids.count) { _, count in
            if cursor >= count { cursor = 0 }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: sessionMode ? "arrow.left.arrow.right" : "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
            TextField(
                sessionMode ? "Switch to session…" : "Search what was said in all sessions…",
                text: $query
            )
            .textFieldStyle(.plain)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .submitLabel(.go)
            .focused($fieldFocused)
            .onSubmit { openRow(cursor) }
            .onKeyPress(.downArrow) {
                moveCursor(1)
                return .handled
            }
            .onKeyPress(.upArrow) {
                moveCursor(-1)
                return .handled
            }
            .onKeyPress(.tab) {
                switchMode()
                return .handled
            }
            if loading {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private func resultList(ranked: [RankedSession], ids: [String]) -> some View {
        let tooShort = !sessionMode && trimmedQuery.count < Self.minContentQuery
        let empty = !loading && !tooShort && ids.isEmpty
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if sessionMode {
                        ForEach(Array(ranked.enumerated()), id: \.element.id) { index, row in
                            Button {
                                openRow(index)
                            } label: {
                                SessionPaletteRow(row: row, active: index == cursor)
                            }
                            .buttonStyle(.plain)
                            .id(row.id)
                            .onHover { if $0 { cursor = index } }
                        }
                    } else {
                        ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                            Button {
                                openRow(index)
                            } label: {
                                ContentPaletteRow(
                                    hit: hit,
                                    session: app.sessionList.sessions[hit.sessionId],
                                    origin: originLabel(for: hit.sessionId),
                                    active: index == cursor
                                )
                            }
                            .buttonStyle(.plain)
                            .id(hit.id)
                            .onHover { if $0 { cursor = index } }
                        }
                    }
                    if tooShort {
                        placeholder("Search prompts and answers across every session.")
                    } else if empty {
                        placeholder(trimmedQuery.isEmpty
                            ? "No sessions yet."
                            : "No matches for “\(trimmedQuery)”")
                    }
                }
            }
            // Keep the keyboard cursor inside the viewport.
            .onChange(of: cursor) { _, index in
                guard ids.indices.contains(index) else { return }
                proxy.scrollTo(ids[index])
            }
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.tertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)
            .padding(.horizontal, 16)
    }

    private func footer(count: Int) -> some View {
        HStack {
            Text(sessionMode
                ? "↑↓ navigate · ⏎ open · tab search content · esc close"
                : "↑↓ navigate · ⏎ open · tab switch session · esc close")
            Spacer()
            if count > 0 {
                Text("\(count) \(sessionMode ? "sessions" : "matches")")
            }
        }
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .overlay(alignment: .top) { Divider() }
    }

    // MARK: Actions

    private func moveCursor(_ delta: Int) {
        let count = rowIds.count
        guard count > 0 else { return }
        cursor = min(max(cursor + delta, 0), count - 1)
    }

    private func switchMode() {
        app.openPalette(sessionMode ? .content : .session)
    }

    private func openRow(_ index: Int) {
        let ids = rowIds
        guard ids.indices.contains(index) else { return }
        let sessionId = ids[index]
        app.closePalette()
        app.route = .session(sessionId)
    }

    private func originLabel(for sessionId: String) -> String? {
        guard let session = app.sessionList.sessions[sessionId] else { return nil }
        return PaletteOrigin.text(app.sessionList.searchCandidate(for: session, fleet: app.fleet))
    }

    /// Content mode: debounced server query. Cancelling the previous task
    /// is what keeps a slow early request from resolving after a fast
    /// later one and overwriting good results (the web's AbortController).
    private func runContentSearch() {
        searchTask?.cancel()
        searchTask = nil
        guard !sessionMode, let client = app.client else {
            hits = []
            loading = false
            return
        }
        let q = trimmedQuery
        guard q.count >= Self.minContentQuery else {
            hits = []
            loading = false
            return
        }
        loading = true
        searchTask = Task {
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled else { return }
            do {
                let response = try await client.searchSessions(query: q)
                guard !Task.isCancelled else { return }
                hits = response.hits
                cursor = 0
                loading = false
            } catch {
                // Cancelled or failed — leave the previous page up. 401s
                // still funnel to the login screen.
                guard !Task.isCancelled else { return }
                app.handleAPIError(error)
                loading = false
            }
        }
    }
}

/// "project · machine" for a row's trailing label; nil when neither
/// resolves (a workdir-less session, or a project row not yet hydrated).
enum PaletteOrigin {
    static func text(_ candidate: SessionCandidate) -> String? {
        let parts = [candidate.projectLabel, candidate.machineName]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// ⌘P row: what the session is called and where it lives.
private struct SessionPaletteRow: View {
    let row: RankedSession
    let active: Bool

    var body: some View {
        HStack(spacing: 8) {
            AgentTypeIcon(type: row.session.cliType ?? "custom", size: 13)
                .frame(width: 16)
            Text(row.session.title)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(1)
            if row.session.archivedAt != nil {
                ArchivedTag()
            }
            Spacer(minLength: 8)
            if let origin = PaletteOrigin.text(row.candidate) {
                Text(origin)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .background(active ? Color.surface2 : Color.clear)
    }
}

/// ⌘K row: the session plus why it matched.
private struct ContentPaletteRow: View {
    let hit: SessionSearchHitDTO
    let session: SessionDTO?
    let origin: String?
    let active: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let cliType = session?.cliType {
                    AgentTypeIcon(type: cliType, size: 13).frame(width: 16)
                }
                // A hit whose session hasn't hydrated yet (or was deleted
                // under us) still gets a row — the snippet is the useful
                // part, and dropping it would under-report the count.
                Text(session?.title ?? "Untitled session")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if session?.archivedAt != nil {
                    ArchivedTag()
                }
                Spacer(minLength: 6)
                if hit.matchCount > 1 {
                    Text("\(hit.matchCount) turns")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Text(Self.snippet(hit.snippet))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if let origin {
                Text(origin)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .background(active ? Color.surface2 : Color.clear)
    }

    /// The server's `[[hl]]`-marked snippet as one attributed string.
    /// Built from `SearchSnippet.runs` so transcript text is only ever
    /// native text — never an HTML sink.
    private static func snippet(_ raw: String) -> AttributedString {
        var out = AttributedString()
        for run in SearchSnippet.runs(raw) {
            var piece = AttributedString(run.text)
            if run.highlighted {
                piece.inlinePresentationIntent = .stronglyEmphasized
                piece.foregroundColor = .primary
                piece.backgroundColor = Color.toolAmber.opacity(0.3)
            }
            out += piece
        }
        return out
    }
}

private struct ArchivedTag: View {
    var body: some View {
        Text("archived")
            .font(.system(size: 9, weight: .medium))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Color.surface2, in: RoundedRectangle(cornerRadius: 3))
    }
}
