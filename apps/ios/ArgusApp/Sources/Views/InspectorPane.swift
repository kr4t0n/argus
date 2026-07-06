import SwiftUI
import ArgusKit

/// Right inspector for a session — the iOS counterpart of the web's
/// ContextPane: agent identity header + Files / Commits / Diff tabs.
/// Joins the `agent:{id}` socket room while visible so fs/git change
/// events refresh the panels live.
struct InspectorPane: View {
    @Environment(AppModel.self) private var app
    let sessionId: String

    private enum Tab: String {
        case commits = "Commits"
        case files = "Files"
        case note = "Note"
        case progress = "Progress"
        case diff = "Diff"
    }

    @State private var tab: Tab = .commits

    private var session: SessionDTO? { app.sessionList.sessions[sessionId] }
    private var agent: AgentDTO? { session.flatMap { app.fleet.agents[$0.agentId] } }

    /// Web ContextPane order: Commits, Files, (Terminal — not on iOS
    /// yet), Note, Progress, Diff — extension tabs gated on the
    /// account-level flags, Note additionally on a workingDir (a note is
    /// project-scoped by definition).
    private var tabs: [Tab] {
        var result: [Tab] = [.commits, .files]
        if app.extensions.notes, agent?.workingDir != nil { result.append(.note) }
        if app.extensions.progress, agent?.workingDir != nil { result.append(.progress) }
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

            if let agent {
                switch tab {
                case .commits:
                    CommitsPanel(agent: agent)
                case .files:
                    FileBrowserPanel(agent: agent)
                case .note:
                    NotePanel(agent: agent)
                case .progress:
                    ProgressPanel(agent: agent)
                case .diff:
                    DiffPanel()
                }
            } else {
                ContentUnavailableView(
                    "Agent unavailable",
                    systemImage: "questionmark.circle"
                )
            }
        }
        .onAppear { if let agent { app.stream?.joinAgent(agent.id) } }
        .onDisappear { if let agent { app.stream?.leaveAgent(agent.id) } }
        .onChange(of: tabs) {
            // A toggled-off extension can strand the selection.
            if !tabs.contains(tab) { tab = .commits }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                AgentTypeIcon(type: agent?.type ?? "custom")
                Text(agent?.name ?? "agent")
                    .font(.headline)
                Spacer()
                if let status = agent?.status {
                    Text(status.rawValue)
                        .font(.caption2)
                        .foregroundStyle(status == .online ? .green : .secondary)
                }
            }
            if let machineName = agent?.machineName, !machineName.isEmpty {
                Text(machineName).font(.caption).foregroundStyle(.secondary)
            }
            if let workingDir = agent?.workingDir {
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
}

// MARK: - Files

private struct FileBrowserPanel: View {
    @Environment(AppModel.self) private var app
    let agent: AgentDTO

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
            guard let change = app.lastFSChange, change.agentId == agent.id else { return }
            if change.path == path || change.path.isEmpty || path.hasPrefix(change.path) {
                Task { await load() }
            }
        }
        .sheet(item: fileSheetBinding) { box in
            FileViewerSheet(agent: agent, path: box.value)
        }
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
            let response = try await client.listAgentDir(agentId: agent.id, path: path)
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

private struct FileViewerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let agent: AgentDTO
    let path: String

    @State private var result: FSReadResult?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                switch result {
                case .none:
                    if let loadError {
                        ContentUnavailableView(
                            "Couldn't read file",
                            systemImage: "exclamationmark.triangle",
                            description: Text(loadError)
                        )
                    } else {
                        ProgressView()
                    }
                case .text(let content, _):
                    ScrollView([.vertical, .horizontal]) {
                        Text(content)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                case .image(_, let base64, _):
                    if let data = Data(base64Encoded: base64),
                       let image = UIImage(data: data) {
                        ScrollView {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                        }
                    } else {
                        ContentUnavailableView("Couldn't decode image", systemImage: "photo")
                    }
                case .binary(let size):
                    ContentUnavailableView(
                        "Binary file",
                        systemImage: "doc.zipper",
                        description: Text(TokenFormat.bytes(size))
                    )
                case .unsupported(let kind):
                    ContentUnavailableView(
                        "Unsupported viewer (\(kind))",
                        systemImage: "doc.questionmark"
                    )
                }
            }
            .navigationTitle((path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                guard let client = app.client else { return }
                do {
                    result = try await client.readAgentFile(agentId: agent.id, path: path).result
                } catch {
                    app.handleAPIError(error)
                    loadError = (error as? APIError)?.message ?? error.localizedDescription
                }
            }
        }
    }
}

// MARK: - Commits

private struct CommitsPanel: View {
    @Environment(AppModel.self) private var app
    let agent: AgentDTO

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
            guard app.lastGitChange?.agentId == agent.id else { return }
            Task { await load() }
        }
    }

    private func load() async {
        guard let client = app.client else { return }
        do {
            response = try await client.getAgentGitLog(agentId: agent.id, limit: 50)
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
    let agent: AgentDTO

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
        ((agent.workingDir ?? "") as NSString).lastPathComponent
    }

    private func load() async {
        guard let client = app.client, let workingDir = agent.workingDir else { return }
        do {
            text = try await client.getProjectNotes(
                machineId: agent.machineId, workingDir: workingDir
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
                  let client = app.client,
                  let workingDir = agent.workingDir
            else { return }
            do {
                try await client.setProjectNotes(
                    machineId: agent.machineId, workingDir: workingDir, notes: text
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

/// Progress extension: live background tasks reported by `argus-bg` in
/// the agent's shell. Joins the project room while visible; REST
/// hydrates, `background-task:*` events keep it fresh.
private struct ProgressPanel: View {
    @Environment(AppModel.self) private var app
    let agent: AgentDTO

    @State private var tasks: [String: BackgroundTaskDTO] = [:]
    @State private var loaded = false

    private var workingDir: String { agent.workingDir ?? "" }

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
        .onAppear {
            app.stream?.joinProject(machineId: agent.machineId, workingDir: workingDir)
        }
        .onDisappear {
            app.stream?.leaveProject(machineId: agent.machineId, workingDir: workingDir)
        }
        .onChange(of: app.lastBackgroundTaskUpdate) {
            guard let update = app.lastBackgroundTaskUpdate,
                  update.machineId == agent.machineId, update.workingDir == workingDir
            else { return }
            tasks[update.taskId] = update
        }
        .onChange(of: app.lastBackgroundTaskRemoval) {
            guard let removal = app.lastBackgroundTaskRemoval,
                  removal.machineId == agent.machineId, removal.workingDir == workingDir
            else { return }
            tasks[removal.taskId] = nil
        }
    }

    private func load() async {
        guard let client = app.client, !workingDir.isEmpty else { return }
        do {
            let list = try await client.listBackgroundTasks(
                machineId: agent.machineId, workingDir: workingDir
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
                machineId: agent.machineId, workingDir: workingDir, taskId: task.taskId
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
        guard let session = app.activeSession,
              let workingDir = app.fleet.agents[
                  app.sessionList.sessions[session.sessionId]?.agentId ?? ""
              ]?.workingDir,
              path.hasPrefix(workingDir)
        else { return path }
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
            byPath[path, default: []].append(item.text)
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
