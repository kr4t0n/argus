import SwiftUI
import ArgusKit

/// Right inspector for a session — the iOS counterpart of the web's
/// ContextPane: identity header + Files / Commits / Diff tabs. Files,
/// Commits, Note and Progress are project-addressed (ProjectRef) since
/// the runner refactor; the agent row only drives the Terminal tab and
/// enriches the header when it still exists. Joins the project socket
/// room while visible (runner sidecars nudge only that room) PLUS the
/// legacy `agent:{id}` room during the mixed-fleet window, so fs/git
/// change events refresh the panels live on both sidecar generations.
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
    /// Legacy agent row — still owns the PTY (the terminal-open route is
    /// agent-addressed) and the header identity when present. Every
    /// fs/git surface below works without it.
    private var agent: AgentDTO? {
        session?.agentId.flatMap { app.fleet.agents[$0] }
    }
    /// Project addressing for Files/Commits/Note/Progress; nil for
    /// workdir-less sessions (those panes have no surface there).
    private var projectRef: ProjectRef? { app.fleet.projectRef(for: session) }
    /// The hydrated Project row for `projectRef` (pair-keyed store).
    private var projectRow: ProjectDTO? {
        projectRef.flatMap {
            app.fleet.projects[FleetStore.projectKey(
                machineId: $0.machineId, workingDir: $0.workingDir
            )]
        }
    }
    /// Terminal capability moved to the Project row with the terminal
    /// switchover (the migration inherited it from terminal-capable
    /// agents); the agent flag remains for workdir-less sessions still
    /// on the legacy open route.
    private var supportsTerminal: Bool {
        projectRow?.supportsTerminal == true || agent?.supportsTerminal == true
    }

    /// Web ContextPane order: Commits, Files, Terminal, Note, Progress,
    /// Diff. Terminal appears only for agents created with the PTY
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
                    CommitsPanel(project: project, legacyAgentId: agent?.id)
                } else {
                    noProjectPlaceholder
                }
            case .files:
                if let project = projectRef {
                    FileBrowserPanel(project: project, legacyAgentId: agent?.id)
                } else {
                    noProjectPlaceholder
                }
            case .terminal:
                // Lazy like the web: the PTY opens on first visit,
                // then the controller (and its scrollback) survives
                // tab switches for the inspector's lifetime.
                if let terminalController {
                    TerminalPanel(controller: terminalController)
                } else if projectRef != nil || agent != nil {
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
        .onAppear { joinRooms(project: projectRef, agentId: agent?.id) }
        .onDisappear {
            leaveRooms(project: projectRef, agentId: agent?.id)
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
        .onChange(of: agent?.id) { old, new in
            if let old { app.stream?.leaveAgent(old) }
            if let new { app.stream?.joinAgent(new) }
        }
        .onChange(of: tabs) {
            // A toggled-off extension can strand the selection.
            if !tabs.contains(tab) { tab = .commits }
        }
    }

    /// Join the project room (runner sidecars broadcast fs/git nudges
    /// there — this is what fixes live refresh against ≥0.3 sidecars)
    /// and KEEP the legacy agent-room join for pre-Phase-2 sidecars,
    /// exactly like the web FileTree. The shim dies with Phase 4.
    private func joinRooms(project: ProjectRef?, agentId: String?) {
        if let project {
            app.stream?.joinProject(machineId: project.machineId, workingDir: project.workingDir)
        }
        if let agentId { app.stream?.joinAgent(agentId) }
    }

    private func leaveRooms(project: ProjectRef?, agentId: String?) {
        if let project {
            app.stream?.leaveProject(machineId: project.machineId, workingDir: project.workingDir)
        }
        if let agentId { app.stream?.leaveAgent(agentId) }
    }

    private var noProjectPlaceholder: some View {
        ContentUnavailableView(
            "No project",
            systemImage: "folder.badge.questionmark",
            description: Text("This session isn't pinned to a working directory.")
        )
    }

    /// Project-addressed open when the session is pinned to one (works
    /// with no agent row); the agent route covers workdir-less sessions.
    private func makeTerminalController() {
        guard terminalController == nil,
              let client = app.client, let stream = app.stream
        else { return }
        let controller = TerminalController(
            project: projectRef, agent: agent, client: client, stream: stream
        )
        terminalController = controller
        app.activeTerminal = controller
    }

    /// Agent identity when the row still exists; otherwise the project's
    /// basename carries the header, so nothing blanks once agent rows
    /// retire.
    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                AgentTypeIcon(type: session?.cliType ?? agent?.type ?? "custom")
                Text(agent?.name ?? headerFallbackTitle)
                    .font(.headline)
                Spacer()
                if let status = agent?.status {
                    Text(status.rawValue)
                        .font(.caption2)
                        .foregroundStyle(status == .online ? .green : .secondary)
                }
            }
            if let machineName = headerMachineName, !machineName.isEmpty {
                Text(machineName).font(.caption).foregroundStyle(.secondary)
            }
            if let workingDir = projectRef?.workingDir ?? agent?.workingDir {
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
        if let name = agent?.machineName, !name.isEmpty { return name }
        return projectRef.flatMap { app.fleet.machines[$0.machineId]?.name }
    }
}

// MARK: - Files

private struct FileBrowserPanel: View {
    @Environment(AppModel.self) private var app
    let project: ProjectRef
    /// Pre-Phase-2 sidecars nudge the agent room only (no workingDir on
    /// the event) — match on this when the event carries no pair. Dies
    /// with Phase 4.
    let legacyAgentId: String?

    /// Path relative to the workingDir ("" = root).
    @State private var path = ""
    @State private var entries: [FSEntry]?
    @State private var git: GitStatus?
    @State private var loadError: String?
    @State private var viewingFile: String?

    var body: some View {
        VStack(spacing: 0) {
            breadcrumb
            Divider()
            listBody
        }
        .task(id: path) { await load() }
        .onChange(of: app.lastFSChange) {
            // The sidecar debounces; refetch when our directory changed.
            guard let change = app.lastFSChange, matches(change) else { return }
            if change.path == path || change.path.isEmpty || path.hasPrefix(change.path) {
                Task { await load() }
            }
        }
        .sheet(item: fileSheetBinding) { box in
            FilePreviewSheet(
                project: project,
                target: FilePreviewTarget(path: box.value, displayPath: box.value, line: nil)
            )
        }
    }

    /// Runner events carry the (machineId, workingDir) pair (agentId is
    /// empty) — match on the pair; legacy events carry only agentId.
    /// Same rule as the web FileTree.
    private func matches(_ change: FSChangedPayload) -> Bool {
        if let workingDir = change.workingDir, !workingDir.isEmpty {
            return change.machineId == project.machineId && workingDir == project.workingDir
        }
        return legacyAgentId != nil && change.agentId == legacyAgentId
    }

    private var breadcrumb: some View {
        HStack(spacing: 6) {
            Button {
                path = ""
            } label: {
                Image(systemName: "house")
            }
            .disabled(path.isEmpty)
            if !path.isEmpty {
                Button {
                    path = (path as NSString).deletingLastPathComponent
                } label: {
                    Image(systemName: "chevron.up")
                }
                Text(path)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer()
            if let git {
                Label(git.branch ?? git.head, systemImage: "arrow.branch")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .padding(.horizontal)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var listBody: some View {
        if let entries {
            if entries.isEmpty {
                ContentUnavailableView("Empty directory", systemImage: "folder")
            } else {
                List(sorted(entries), id: \.name) { entry in
                    Button {
                        open(entry)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: symbol(for: entry))
                                .foregroundStyle(entry.kind == .dir ? Color.accentColor : .secondary)
                                .frame(width: 18)
                            Text(entry.name)
                                .lineLimit(1)
                            Spacer()
                            if entry.kind == .file {
                                Text(TokenFormat.bytes(entry.size))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
                .refreshable { await load() }
            }
        } else if let loadError {
            ContentUnavailableView(
                "Couldn't list files",
                systemImage: "exclamationmark.triangle",
                description: Text(loadError)
            )
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var fileSheetBinding: Binding<StringBox?> {
        Binding(
            get: { viewingFile.map(StringBox.init) },
            set: { viewingFile = $0?.value }
        )
    }

    private func sorted(_ entries: [FSEntry]) -> [FSEntry] {
        entries.sorted {
            if ($0.kind == .dir) != ($1.kind == .dir) { return $0.kind == .dir }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private func symbol(for entry: FSEntry) -> String {
        switch entry.kind {
        case .dir: return "folder.fill"
        case .symlink: return "link"
        default: return "doc"
        }
    }

    private func open(_ entry: FSEntry) {
        let child = path.isEmpty ? entry.name : "\(path)/\(entry.name)"
        if entry.kind == .dir {
            path = child
        } else {
            viewingFile = child
        }
    }

    private func load() async {
        guard let client = app.client else { return }
        do {
            let response = try await client.listProjectDir(projectId: project.projectId, path: path)
            entries = response.entries
            git = response.git
            loadError = nil
        } catch {
            app.handleAPIError(error)
            loadError = (error as? APIError)?.message ?? error.localizedDescription
            entries = nil
        }
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

private struct CommitsPanel: View {
    @Environment(AppModel.self) private var app
    let project: ProjectRef
    /// Legacy agent-room matching — same shim as FileBrowserPanel.
    let legacyAgentId: String?

    @State private var response: GitLogResponse?
    @State private var loadError: String?

    var body: some View {
        Group {
            if let response {
                if response.commits.isEmpty {
                    ContentUnavailableView(
                        "No commits",
                        systemImage: "arrow.branch",
                        description: Text("Not a git repo, or no commits yet.")
                    )
                } else {
                    List {
                        if let git = response.git {
                            Label(git.branch ?? git.head, systemImage: "arrow.branch")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        ForEach(response.commits) { commit in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(commit.subject).font(.callout).lineLimit(2)
                                HStack(spacing: 6) {
                                    Text(commit.shortSha)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.tertiary)
                                    Text(commit.authorName)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Text(RelativeTime.label(iso: commit.authorDate))
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await load() }
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

    /// Pair-first matching, legacy agentId fallback — the same rule as
    /// FileBrowserPanel / the web GitLogPanel.
    private func matches(_ change: GitChangedPayload) -> Bool {
        if let workingDir = change.workingDir, !workingDir.isEmpty {
            return change.machineId == project.machineId && workingDir == project.workingDir
        }
        return legacyAgentId != nil && change.agentId == legacyAgentId
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
        // Project row first (survives the agent's retirement), agent row
        // as the legacy fallback for pre-backfill sessions.
        let workingDir = app.fleet.projectRef(for: session)?.workingDir
            ?? session?.agentId.flatMap { app.fleet.agents[$0]?.workingDir }
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
