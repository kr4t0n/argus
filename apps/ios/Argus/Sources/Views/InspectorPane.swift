import SwiftUI
import UIKit
import ArgusKit

/// Right inspector for a session — the iOS counterpart of the web's
/// ContextPane: identity header + Files / Commits / Terminal / Diff
/// tabs. Every pane is project-addressed (ProjectRef) since the runner
/// refactor retired the Agent entity. Joins the project socket room
/// while visible (runner sidecars nudge only that room) so fs/git change
/// events refresh the panels live.
struct InspectorPane: View {
    @Environment(AppModel.self) private var app
    let sessionId: String

    private enum Tab: String {
        case commits = "Commits"
        case files = "Files"
        case terminal = "Terminal"
        case note = "Note"
        case progress = "Progress"
        case diff = "Diff"
    }

    @State private var tab: Tab = .commits
    @State private var terminalController: TerminalController?

    private var session: SessionDTO? { app.sessionList.sessions[sessionId] }
    /// Project addressing for Files/Commits/Note/Progress/Terminal; nil
    /// for workdir-less sessions (those panes have no surface there).
    private var projectRef: ProjectRef? { app.fleet.projectRef(for: session) }
    /// The hydrated Project row for `projectRef` (pair-keyed store).
    private var projectRow: ProjectDTO? {
        projectRef.flatMap {
            app.fleet.projects[FleetStore.projectKey(
                machineId: $0.machineId, workingDir: $0.workingDir
            )]
        }
    }
    /// Terminal capability lives on the Project row (the runner opens
    /// PTYs by cwd — the Agent entity that used to own them is retired).
    private var supportsTerminal: Bool {
        projectRow?.supportsTerminal == true
    }

    /// Web ContextPane order: Commits, Files, Terminal, Note, Progress,
    /// Diff. Terminal appears only for projects whose runner has the PTY
    /// opt-in; extension tabs gate on the account-level flags, Note/
    /// Progress additionally on a resolved project (both are
    /// project-scoped).
    private var tabs: [Tab] {
        var result: [Tab] = [.commits, .files]
        if supportsTerminal { result.append(.terminal) }
        if app.extensions.notes, projectRef != nil { result.append(.note) }
        if app.extensions.progress, projectRef != nil { result.append(.progress) }
        if app.extensions.diff { result.append(.diff) }
        return result
    }

    var body: some View {
        let tabs = self.tabs
        VStack(spacing: 0) {
            header
            Picker("Tab", selection: $tab) {
                ForEach(tabs, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.bottom, 8)
            Divider()

            switch tab {
            case .commits:
                if let project = projectRef {
                    CommitsPanel(project: project)
                } else {
                    noProjectPlaceholder
                }
            case .files:
                if let project = projectRef {
                    FileTreePanel(project: project)
                } else {
                    noProjectPlaceholder
                }
            case .terminal:
                // The controller is created lazily on first visit, but
                // the PTY itself opens on user demand (the tab's "Open
                // shell" CTA — web parity). Controller + scrollback
                // survive tab switches for the inspector's lifetime.
                if let terminalController {
                    TerminalPanel(controller: terminalController)
                } else if projectRef != nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .onAppear { makeTerminalController() }
                } else {
                    noProjectPlaceholder
                }
            case .note:
                if let project = projectRef {
                    NotePanel(project: project)
                } else {
                    noProjectPlaceholder
                }
            case .progress:
                if let project = projectRef {
                    ProgressPanel(project: project)
                } else {
                    noProjectPlaceholder
                }
            case .diff:
                DiffPanel()
            }
        }
        .onAppear { joinRooms(project: projectRef) }
        .onDisappear {
            leaveRooms(project: projectRef)
            terminalController?.shutdown()
            if app.activeTerminal === terminalController { app.activeTerminal = nil }
            terminalController = nil
        }
        // The stores may hydrate (or re-resolve) while the inspector is
        // open — keep room membership in step, like the web effect's
        // dependency array.
        .onChange(of: projectRef) { old, new in
            if let old { app.stream?.leaveProject(machineId: old.machineId, workingDir: old.workingDir) }
            if let new { app.stream?.joinProject(machineId: new.machineId, workingDir: new.workingDir) }
        }
        .onChange(of: tabs) {
            // A toggled-off extension can strand the selection.
            if !tabs.contains(tab) { tab = .commits }
        }
    }

    /// Join the project room — runner sidecars broadcast fs/git nudges
    /// there (keyed by the `(machineId, workingDir)` pair). The Agent
    /// entity is retired, so there's no agent room to join anymore.
    private func joinRooms(project: ProjectRef?) {
        if let project {
            app.stream?.joinProject(machineId: project.machineId, workingDir: project.workingDir)
        }
    }

    private func leaveRooms(project: ProjectRef?) {
        if let project {
            app.stream?.leaveProject(machineId: project.machineId, workingDir: project.workingDir)
        }
    }

    private var noProjectPlaceholder: some View {
        ContentUnavailableView(
            "No project",
            systemImage: "folder.badge.questionmark",
            description: Text("This session isn't pinned to a working directory.")
        )
    }

    /// Project-addressed open — the runner opens the PTY by cwd. A
    /// session with no project has no terminal surface.
    private func makeTerminalController() {
        guard terminalController == nil,
              let client = app.client, let stream = app.stream
        else { return }
        let controller = TerminalController(
            project: projectRef, client: client, stream: stream
        )
        terminalController = controller
        app.activeTerminal = controller
    }

    /// Header identity: the session's pinned cliType + the project's
    /// basename (the Agent row that used to enrich this is retired).
    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                AgentTypeIcon(type: session?.cliType ?? "custom")
                Text(headerFallbackTitle)
                    .font(.headline)
                Spacer()
            }
            if let machineName = headerMachineName, !machineName.isEmpty {
                Text(machineName).font(.caption).foregroundStyle(.secondary)
            }
            if let workingDir = projectRef?.workingDir {
                Text(workingDir)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }

    private var headerFallbackTitle: String {
        if let workingDir = projectRef?.workingDir, !workingDir.isEmpty {
            return (workingDir as NSString).lastPathComponent
        }
        return "session"
    }

    private var headerMachineName: String? {
        projectRef.flatMap { app.fleet.machines[$0.machineId]?.name }
    }
}

// MARK: - Files

/// Compact lazy-expanding file tree — the iOS port of the web FileTree,
/// replacing the older drill-down List (default row heights + separators
/// read loose next to the web's dense panel). Rows are chevron · icon ·
/// name in caption-mono at a fixed 24pt, indented 12pt per level, no
/// separators. Cold expansions pull `prefetchDepth` levels in one round
/// trip and hydrate a flat `path → DirState` cache so the next taps
/// render synchronously; collapse keeps the cache so re-expanding is
/// instant. `fs:changed` refetches exactly the loaded level it names.
/// Size/mtime live in the row's long-press menu (the web keeps them in
/// tooltips). Tapping a file opens the shared FilePreviewSheet.
private struct FileTreePanel: View {
    @Environment(AppModel.self) private var app
    let project: ProjectRef

    private struct DirState {
        var entries: [FSEntry] = []
        var loading = false
        var error: String?
    }

    /// Directory levels fetched per round trip (web TREE_PREFETCH_DEPTH):
    /// root + two more are warm before the first tap.
    private static let prefetchDepth = 3

    /// Keyed by path relative to the workingDir ("" = root). Entries
    /// survive collapse on purpose — re-expanding renders from cache.
    @State private var dirs: [String: DirState] = [:]
    @State private var expanded: Set<String> = [""]
    @State private var showAll = false
    @State private var git: GitStatus?
    @State private var viewingFile: String?

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            content
        }
        .task(id: project.projectId) {
            dirs = [:]
            expanded = [""]
            git = nil
            await fetchDir("", depth: Self.prefetchDepth)
        }
        // Filter flip collapses back to the root and refetches with the
        // new filter — same shape as refreshAll (web behavior).
        .onChange(of: showAll) { refreshAll() }
        .onChange(of: app.fsChangeSeq) {
            // Watch the SEQ, not the payload: repeat writes to one
            // directory produce an Equatable-identical payload, which
            // `.onChange` would swallow (see AppModel.fsChangeSeq).
            // The sidecar debounces; refetch exactly the level that
            // changed, if we've already loaded it.
            guard let change = app.lastFSChange, matches(change) else { return }
            if dirs[change.path] != nil {
                Task { await fetchDir(change.path) }
            }
        }
        .sheet(item: fileSheetBinding) { box in
            FilePreviewSheet(
                project: project,
                target: FilePreviewTarget(path: box.value, displayPath: box.value, line: nil)
            )
        }
    }

    /// Runner events carry the (machineId, workingDir) pair — match on
    /// it. Same rule as the web FileTree.
    private func matches(_ change: FSChangedPayload) -> Bool {
        guard let workingDir = change.workingDir, !workingDir.isEmpty else { return false }
        return change.machineId == project.machineId && workingDir == project.workingDir
    }

    /// Branch badge + gitignored eye + refresh — the web tree's header
    /// row. The drill-down breadcrumb is gone; a tree needs none.
    private var toolbar: some View {
        HStack(spacing: 12) {
            if let git {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.branch")
                    Text(git.detached ? git.head : (git.branch ?? git.head))
                }
                .font(.caption2.monospaced())
                .foregroundStyle(git.detached ? Color.toolAmber : Color.secondary)
                .lineLimit(1)
            }
            Spacer()
            Button {
                showAll.toggle()
            } label: {
                Image(systemName: showAll ? "eye" : "eye.slash")
            }
            .help(showAll ? "Hide gitignored" : "Show gitignored")
            Button {
                refreshAll()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    @ViewBuilder
    private var content: some View {
        if let root = dirs[""] {
            if let error = root.error, root.entries.isEmpty {
                ContentUnavailableView(
                    "Couldn't list files",
                    systemImage: "exclamationmark.triangle",
                    description: Text(error)
                )
            } else if root.loading, root.entries.isEmpty {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if root.entries.isEmpty {
                ContentUnavailableView("Empty directory", systemImage: "folder")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(nodes()) { node in
                            nodeView(node)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .refreshable { await fetchDir("", depth: Self.prefetchDepth) }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// One visible row — the recursive tree flattened for LazyVStack
    /// (which can't recurse). Message rows carry a per-level error or
    /// "(empty)" placeholder, like the web's inline states.
    private struct Node: Identifiable {
        enum Kind {
            case entry(FSEntry)
            case message(String, isError: Bool)
        }
        let id: String
        let kind: Kind
        let path: String
        let depth: Int
    }

    private func nodes() -> [Node] {
        var out: [Node] = []
        func walk(_ dirPath: String, depth: Int) {
            guard let state = dirs[dirPath] else { return }
            for entry in state.entries {
                let path = dirPath.isEmpty ? entry.name : "\(dirPath)/\(entry.name)"
                out.append(Node(id: path, kind: .entry(entry), path: path, depth: depth))
                guard entry.kind == .dir, expanded.contains(path) else { continue }
                if let child = dirs[path], let error = child.error {
                    out.append(Node(
                        id: path + "#error", kind: .message(error, isError: true),
                        path: path, depth: depth + 1
                    ))
                } else if let child = dirs[path], !child.loading, child.entries.isEmpty {
                    out.append(Node(
                        id: path + "#empty", kind: .message("(empty)", isError: false),
                        path: path, depth: depth + 1
                    ))
                } else {
                    walk(path, depth: depth + 1)
                }
            }
        }
        walk("", depth: 0)
        return out
    }

    @ViewBuilder
    private func nodeView(_ node: Node) -> some View {
        switch node.kind {
        case .entry(let entry):
            entryRow(path: node.path, entry: entry, depth: node.depth)
        case .message(let text, let isError):
            Text(text)
                .font(.caption2.monospaced())
                .foregroundStyle(isError ? Color.red : Color.secondary)
                .lineLimit(1)
                .padding(.leading, leadingInset(depth: node.depth) + 24)
                .frame(height: 22)
        }
    }

    private func entryRow(path: String, entry: FSEntry, depth: Int) -> some View {
        let isDir = entry.kind == .dir
        let isOpen = isDir && expanded.contains(path)
        return Button {
            tap(path: path, entry: entry)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                    .opacity(isDir ? 1 : 0)
                    .frame(width: 10)
                Image(systemName: symbol(for: entry, open: isOpen))
                    .font(.system(size: 11))
                    .foregroundStyle(tint(for: entry))
                    .frame(width: 15)
                Text(entry.name)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                Spacer(minLength: 4)
                if isDir, dirs[path]?.loading == true {
                    ProgressView().controlSize(.mini)
                }
            }
            .padding(.leading, leadingInset(depth: depth))
            .padding(.trailing, 12)
            .frame(height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(entry.gitignored == true ? 0.55 : 1)
        .contextMenu {
            if entry.kind != .dir {
                Button("Copy path", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = path
                }
                Text("\(TokenFormat.bytes(entry.size)) · \(RelativeTime.label(msEpoch: Double(entry.mtime)))")
            }
        }
    }

    private func leadingInset(depth: Int) -> CGFloat {
        8 + CGFloat(depth) * 12
    }

    private func symbol(for entry: FSEntry, open: Bool) -> String {
        switch entry.kind {
        case .dir: return open ? "folder.fill" : "folder"
        case .symlink: return "link"
        default: return "doc.text"
        }
    }

    private func tint(for entry: FSEntry) -> Color {
        switch entry.kind {
        case .dir: return Color.mdLink.opacity(0.85)
        case .symlink: return .purple.opacity(0.8)
        default: return Color(.tertiaryLabel)
        }
    }

    private func tap(path: String, entry: FSEntry) {
        guard entry.kind == .dir else {
            viewingFile = path
            return
        }
        if expanded.contains(path) {
            expanded.remove(path)
            return
        }
        expanded.insert(path)
        if let cached = dirs[path] {
            // Cached — the folder renders instantly, but slide the
            // prefetch frontier when some child dir hasn't been walked
            // yet, so the user's next tap stays on warm cache.
            if !cached.loading, hasUnwalkedSubdir(cached.entries, parent: path) {
                Task { await fetchDir(path, depth: Self.prefetchDepth) }
            }
        } else {
            // Cold expansion — outside the prefetch window.
            Task { await fetchDir(path, depth: Self.prefetchDepth) }
        }
    }

    /// True when at least one subdirectory has no cached listing yet.
    /// Ignored entries are skipped to match the sidecar's BFS, which
    /// also refuses to descend into them.
    private func hasUnwalkedSubdir(_ entries: [FSEntry], parent: String) -> Bool {
        entries.contains { entry in
            entry.kind == .dir && entry.gitignored != true
                && dirs[parent.isEmpty ? entry.name : "\(parent)/\(entry.name)"] == nil
        }
    }

    private func fetchDir(_ path: String, depth: Int = 1) async {
        guard let client = app.client else { return }
        var state = dirs[path] ?? DirState()
        state.loading = true
        state.error = nil
        dirs[path] = state
        do {
            let response = try await client.listProjectDir(
                projectId: project.projectId, path: path, showAll: showAll, depth: depth
            )
            // Depth>1 responses hydrate every level the sidecar walked
            // so the next few expansions render from cache; depth=1
            // responses land in `entries` only.
            if let listings = response.listings {
                for (listedPath, entries) in listings {
                    dirs[listedPath] = DirState(entries: entries)
                }
            }
            if response.listings?[path] == nil {
                dirs[path] = DirState(entries: response.entries)
            }
            if path.isEmpty { git = response.git }
        } catch {
            app.handleAPIError(error)
            var failed = dirs[path] ?? DirState()
            failed.loading = false
            failed.error = (error as? APIError)?.message ?? error.localizedDescription
            dirs[path] = failed
        }
    }

    /// Refresh = start over: collapse to the root and re-pull the
    /// prefetch window (web refreshAll).
    private func refreshAll() {
        dirs = [:]
        expanded = [""]
        Task { await fetchDir("", depth: Self.prefetchDepth) }
    }

    private var fileSheetBinding: Binding<StringBox?> {
        Binding(
            get: { viewingFile.map(StringBox.init) },
            set: { viewingFile = $0?.value }
        )
    }
}

/// Identifiable wrapper so a plain String can drive `.sheet(item:)`.
private struct StringBox: Identifiable {
    let value: String
    var id: String { value }
}

// The file viewer itself is the shared FilePreviewSheet (FilePreview.swift)
// — the same one FileChips and path:line answer links open.

// MARK: - Commits

/// Compact commit log — the web GitLogPanel: branch badge + refresh up
/// top, then dense mono `sha · subject · age` rows with no separators.
/// Long-press a row for the author, absolute date, and copy-SHA (the
/// web keeps those in the row tooltip).
private struct CommitsPanel: View {
    @Environment(AppModel.self) private var app
    let project: ProjectRef

    @State private var response: GitLogResponse?
    @State private var loadError: String?

    var body: some View {
        Group {
            if let response {
                VStack(spacing: 0) {
                    toolbar(git: response.git)
                    Divider()
                    if response.commits.isEmpty {
                        ContentUnavailableView(
                            "No commits",
                            systemImage: "arrow.branch",
                            description: Text("Not a git repo, or no commits yet.")
                        )
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                ForEach(response.commits) { commit in
                                    CommitRow(commit: commit)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .refreshable { await load() }
                    }
                }
            } else if let loadError {
                ContentUnavailableView(
                    "Couldn't load commits",
                    systemImage: "exclamationmark.triangle",
                    description: Text(loadError)
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await load() }
        .onChange(of: app.lastGitChange) {
            guard let change = app.lastGitChange, matches(change) else { return }
            Task { await load() }
        }
    }

    /// Branch badge (amber when detached, web parity) + manual refresh.
    private func toolbar(git: GitStatus?) -> some View {
        HStack(spacing: 12) {
            if let git {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.branch")
                    Text(git.detached ? git.head : (git.branch ?? git.head))
                }
                .font(.caption2.monospaced())
                .foregroundStyle(git.detached ? Color.toolAmber : Color.secondary)
                .lineLimit(1)
            }
            Spacer()
            Button {
                Task { await load() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    /// Pair matching — the same rule as FileBrowserPanel / the web
    /// GitLogPanel.
    private func matches(_ change: GitChangedPayload) -> Bool {
        guard let workingDir = change.workingDir, !workingDir.isEmpty else { return false }
        return change.machineId == project.machineId && workingDir == project.workingDir
    }

    private func load() async {
        guard let client = app.client else { return }
        do {
            response = try await client.getProjectGitLog(projectId: project.projectId, limit: 50)
            loadError = nil
        } catch {
            app.handleAPIError(error)
            loadError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}

/// One-line commit row: shortSha · subject · terse age, all mono —
/// the web CommitRow's shape at a fixed 24pt height.
private struct CommitRow: View {
    let commit: GitCommit

    var body: some View {
        HStack(spacing: 8) {
            Text(commit.shortSha)
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
            Text(commit.subject)
                .font(.caption.monospaced())
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(RelativeTime.short(iso: commit.authorDate))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .frame(height: 24)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Copy SHA", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = commit.sha
            }
            Text("\(commit.authorName) · \(RelativeTime.label(iso: commit.authorDate))")
        }
    }
}

// MARK: - Note (per-project scratchpad)

/// Notes extension: a free-form scratchpad scoped to the project
/// (machineId + workingDir) — every session in the same directory sees
/// the same note, synced with the web via /me/project-notes. Debounced
/// autosave like the web (~700 ms), no Save button.
private struct NotePanel: View {
    @Environment(AppModel.self) private var app
    let project: ProjectRef

    @State private var text = ""
    @State private var loaded = false
    @State private var saveState = ""
    @State private var saveTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            if !loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TextEditor(text: $text)
                    .font(.callout)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .onChange(of: text) { scheduleSave() }
                HStack {
                    Text("Shared by every session in \(projectName) — synced to your account.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    Spacer()
                    Text(saveState)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
        }
        .task { await load() }
        .onDisappear { saveTask?.cancel() }
    }

    private var projectName: String {
        (project.workingDir as NSString).lastPathComponent
    }

    private func load() async {
        guard let client = app.client else { return }
        do {
            text = try await client.getProjectNotes(
                machineId: project.machineId, workingDir: project.workingDir
            )
            loaded = true
        } catch {
            app.handleAPIError(error)
            loaded = true
            saveState = "couldn't load"
        }
    }

    private func scheduleSave() {
        saveState = "…"
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled,
                  let client = app.client
            else { return }
            do {
                try await client.setProjectNotes(
                    machineId: project.machineId, workingDir: project.workingDir, notes: text
                )
                saveState = "saved"
            } catch {
                app.handleAPIError(error)
                saveState = "save failed"
            }
        }
    }
}

// MARK: - Progress (background tasks)

/// Progress extension: live background tasks reported by `argus-bg` on
/// the project's machine. InspectorPane holds the project-room
/// subscription for its whole lifetime (a per-panel leave here would
/// also kill the Files/Commits nudges — the room is shared); REST
/// hydrates, `background-task:*` events keep it fresh.
private struct ProgressPanel: View {
    @Environment(AppModel.self) private var app
    let project: ProjectRef

    @State private var tasks: [String: BackgroundTaskDTO] = [:]
    @State private var loaded = false

    private var workingDir: String { project.workingDir }

    private var ordered: [BackgroundTaskDTO] {
        tasks.values.sorted { $0.startedAt > $1.startedAt }
    }

    var body: some View {
        Group {
            if !loaded {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if ordered.isEmpty {
                ContentUnavailableView(
                    "No background tasks",
                    systemImage: "timer",
                    description: Text("Wrap long commands with argus-bg on the agent's machine to see live progress here.")
                )
            } else {
                List(ordered) { task in
                    BackgroundTaskRow(task: task) {
                        dismiss(task)
                    }
                }
                .listStyle(.plain)
                .refreshable { await load() }
            }
        }
        .task { await load() }
        .onChange(of: app.lastBackgroundTaskUpdate) {
            guard let update = app.lastBackgroundTaskUpdate,
                  update.machineId == project.machineId, update.workingDir == workingDir
            else { return }
            tasks[update.taskId] = update
        }
        .onChange(of: app.lastBackgroundTaskRemoval) {
            guard let removal = app.lastBackgroundTaskRemoval,
                  removal.machineId == project.machineId, removal.workingDir == workingDir
            else { return }
            tasks[removal.taskId] = nil
        }
    }

    private func load() async {
        guard let client = app.client, !workingDir.isEmpty else { return }
        do {
            let list = try await client.listBackgroundTasks(
                machineId: project.machineId, workingDir: workingDir
            )
            tasks = Dictionary(uniqueKeysWithValues: list.map { ($0.taskId, $0) })
            loaded = true
        } catch {
            app.handleAPIError(error)
            loaded = true
        }
    }

    private func dismiss(_ task: BackgroundTaskDTO) {
        guard let client = app.client else { return }
        tasks[task.taskId] = nil
        Task {
            try? await client.dismissBackgroundTask(
                machineId: project.machineId, workingDir: workingDir, taskId: task.taskId
            )
        }
    }
}

private struct BackgroundTaskRow: View {
    let task: BackgroundTaskDTO
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text(task.label ?? task.desc ?? task.cmd?.joined(separator: " ") ?? task.taskId)
                    .font(.callout)
                    .lineLimit(1)
                Spacer()
                if task.isEnded {
                    Text(task.status == "failed" ? "failed" : "done")
                        .font(.caption2)
                        .foregroundStyle(task.status == "failed" ? .red : .green)
                    Button(action: onDismiss) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }

            if let percent = task.percent {
                ProgressView(value: min(100, max(0, percent)), total: 100)
                    .tint(task.isEnded ? (task.status == "failed" ? .red : .green) : .blue)
            } else if !task.isEnded {
                ProgressView() // indeterminate: started, no tqdm frame yet
                    .controlSize(.small)
            }

            HStack(spacing: 8) {
                if let current = task.current, let total = task.total {
                    Text("\(Int(current))/\(Int(total))\(task.unit ?? "")")
                }
                if let rate = task.rate {
                    Text(String(format: "%.1f%@/s", rate, task.unit ?? "it"))
                }
                if let eta = task.etaSeconds, !task.isEnded {
                    Text("eta \(Int(eta))s")
                }
                Spacer()
                Text(RelativeTime.label(msEpoch: task.ts))
            }
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Diff (last turn)

private struct FileDiff: Identifiable {
    let path: String
    let text: String
    let additions: Int
    let deletions: Int
    var id: String { path }
}

/// Last-turn file diffs, aggregated client-side from the transcript's
/// `meta.isDiff` chunks — same derivation as the web's DiffPane, no new
/// capture. Reads the open session's live turns, so it updates while a
/// turn is still editing.
private struct DiffPanel: View {
    @Environment(AppModel.self) private var app
    @State private var collapsed: Set<String> = []

    var body: some View {
        let diffs = lastTurnDiffs()
        if diffs.isEmpty {
            ContentUnavailableView(
                "No diffs in the last turn",
                systemImage: "plus.forwardslash.minus",
                description: Text("File edits made by the agent show up here.")
            )
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(diffs) { diff in
                        VStack(alignment: .leading, spacing: 4) {
                            Button {
                                toggle(diff.path)
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 9, weight: .bold))
                                        .rotationEffect(.degrees(collapsed.contains(diff.path) ? 0 : 90))
                                    Text(displayPath(diff.path))
                                        .font(.caption.monospaced())
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                    Spacer()
                                    Text("+\(diff.additions)").font(.caption2).foregroundStyle(.green)
                                    Text("−\(diff.deletions)").font(.caption2).foregroundStyle(.red)
                                }
                            }
                            .buttonStyle(.plain)

                            if !collapsed.contains(diff.path) {
                                DiffText(text: diff.text)
                            }
                        }
                    }
                }
                .padding()
            }
        }
    }

    private func toggle(_ path: String) {
        if collapsed.contains(path) {
            collapsed.remove(path)
        } else {
            collapsed.insert(path)
        }
    }

    private func displayPath(_ path: String) -> String {
        guard let active = app.activeSession else { return path }
        let session = app.sessionList.sessions[active.sessionId]
        // Resolved through the session's pinned project.
        let workingDir = app.fleet.projectRef(for: session)?.workingDir
        guard let workingDir, !workingDir.isEmpty, path.hasPrefix(workingDir) else { return path }
        return String(path.dropFirst(workingDir.count)).trimmingCharacters(
            in: CharacterSet(charactersIn: "/")
        )
    }

    private func lastTurnDiffs() -> [FileDiff] {
        guard let turns = app.activeSession?.turns,
              let turn = turns.last(where: { turn in
                  turn.timeline.contains { $0.isDiff }
              })
        else { return [] }

        var byPath: [String: [String]] = [:]
        var order: [String] = []
        for item in turn.timeline where item.isDiff {
            let path = item.filePath ?? "unknown"
            if byPath[path] == nil { order.append(path) }
            // Diffs now ride the tool row (paired result) — diffBody is
            // the result text falling back to the row's own content.
            byPath[path, default: []].append(item.diffBody)
        }
        return order.map { path in
            let text = byPath[path, default: []].joined(separator: "\n")
            var additions = 0
            var deletions = 0
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                if line.hasPrefix("+"), !line.hasPrefix("+++") { additions += 1 }
                if line.hasPrefix("-"), !line.hasPrefix("---") { deletions += 1 }
            }
            return FileDiff(path: path, text: text, additions: additions, deletions: deletions)
        }
    }
}

/// Colorized unified-diff text: + green, − red, @@ hunks blue.
struct DiffText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()),
                    id: \.offset) { _, line in
                Text(String(line.isEmpty ? " " : line))
                    .font(.caption2.monospaced())
                    .foregroundStyle(color(for: line))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(background(for: line))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func color(for line: Substring) -> Color {
        if line.hasPrefix("+"), !line.hasPrefix("+++") { return .green }
        if line.hasPrefix("-"), !line.hasPrefix("---") { return .red }
        if line.hasPrefix("@@") { return .blue }
        return .secondary
    }

    private func background(for line: Substring) -> Color {
        if line.hasPrefix("+"), !line.hasPrefix("+++") { return .green.opacity(0.08) }
        if line.hasPrefix("-"), !line.hasPrefix("---") { return .red.opacity(0.08) }
        return .clear
    }
}

extension TokenFormat {
    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }
}
