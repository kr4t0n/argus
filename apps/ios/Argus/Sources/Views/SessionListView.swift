import SwiftUI
import ArgusKit

/// Sidebar: sessions grouped by project (the `(machineId, workingDir)`
/// pair), a machines section, and the account row — mirroring the web
/// sidebar's layout. Selection is a DetailRoute so session, machine,
/// and user rows all drive the same detail column.
struct SessionSidebar: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Binding var selection: DetailRoute?

    /// iPhone (compact) gets a little more row height for easier tapping;
    /// iPad (regular) keeps the tighter density.
    private var compact: Bool { sizeClass == .compact }
    private var rowInsets: EdgeInsets {
        EdgeInsets(top: compact ? 7 : 4, leading: 22, bottom: compact ? 7 : 4, trailing: 12)
    }
    private var machineRowInsets: EdgeInsets {
        EdgeInsets(top: compact ? 7 : 4, leading: 14, bottom: compact ? 7 : 4, trailing: 12)
    }
    private var headerInsets: EdgeInsets {
        EdgeInsets(top: compact ? 10 : 6, leading: 12, bottom: compact ? 6 : 4, trailing: 12)
    }
    private var minRowHeight: CGFloat { compact ? 40 : 30 }

    @State private var renameTarget: SessionDTO?
    @State private var renameText = ""
    @State private var newSessionProject: ProjectGroup?
    @State private var showNewProject = false

    // Project management (web project-row hover actions).
    @State private var projectRenameTarget: ProjectGroup?
    @State private var projectRenameText = ""
    @State private var projectIconTarget: ProjectGroup?
    @State private var projectArchiveTarget: ProjectGroup?
    /// Local project-name overrides — web parity: project renames live
    /// client-side (localStorage placeholders there), never on the
    /// server (ProjectDTO carries only the icon).
    @State private var projectNames = SessionSidebar.loadProjectNames()

    // Fleet-wide sidecar update.
    @State private var showBulkUpdate = false

    private static let projectNamesKey = "argus.projectNames"
    private static func loadProjectNames() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: projectNamesKey) as? [String: String] ?? [:]
    }
    private func setProjectName(_ key: String, _ name: String?) {
        if let name, !name.isEmpty {
            projectNames[key] = name
        } else {
            projectNames[key] = nil
        }
        UserDefaults.standard.set(projectNames, forKey: Self.projectNamesKey)
    }

    private func displayTitle(_ group: ProjectGroup) -> String {
        projectNames[group.id] ?? group.title
    }
    /// Collapsed project keys, persisted like the web's uiStore.expanded
    /// (default expanded — a key is present only when collapsed).
    @State private var collapsed = SessionSidebar.loadCollapsed()
    /// Projects with archived sessions revealed — the web's per-project
    /// eye toggle (uiStore.showArchived). Present = shown.
    @State private var showArchived = SessionSidebar.loadShowArchived()

    private static let collapsedKey = "argus.collapsedProjects"
    private static func loadCollapsed() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: collapsedKey) ?? [])
    }
    private func toggleCollapsed(_ key: String) {
        withAnimation(.easeOut(duration: 0.15)) {
            if collapsed.contains(key) { collapsed.remove(key) } else { collapsed.insert(key) }
        }
        UserDefaults.standard.set(Array(collapsed), forKey: Self.collapsedKey)
    }

    private static let showArchivedKey = "argus.showArchivedProjects"
    private static func loadShowArchived() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: showArchivedKey) ?? [])
    }
    private func toggleShowArchived(_ key: String) {
        withAnimation(.easeOut(duration: 0.15)) {
            if showArchived.contains(key) {
                showArchived.remove(key)
            } else {
                showArchived.insert(key)
            }
        }
        UserDefaults.standard.set(Array(showArchived), forKey: Self.showArchivedKey)
    }

    var body: some View {
        VStack(spacing: 0) {
            ConnectionBanner()
            content
        }
        .navigationTitle("Argus")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New project…", systemImage: "folder.badge.plus") {
                        showNewProject = true
                    }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .alert("Rename session", isPresented: renameAlertBinding) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Rename") { commitRename() }
        }
        .alert("Rename project", isPresented: projectRenameAlertBinding) {
            TextField("Name (empty resets)", text: $projectRenameText)
            Button("Cancel", role: .cancel) { projectRenameTarget = nil }
            Button("Rename") { commitProjectRename() }
        } message: {
            Text("Project names are per-device, like on the web.")
        }
        .confirmationDialog(
            "Archive every session in \(projectArchiveTarget.map(displayTitle) ?? "this project")? Each one can be restored individually via the project's eye toggle.",
            isPresented: projectArchiveDialogBinding,
            titleVisibility: .visible
        ) {
            Button("Archive all sessions", role: .destructive) { commitProjectArchive() }
        }
        .sheet(item: $newSessionProject) { project in
            NewSessionSheet(project: project)
        }
        .sheet(isPresented: $showNewProject) {
            NewProjectSheet()
        }
        .sheet(item: $projectIconTarget) { project in
            ProjectIconSheet(project: project)
        }
        .sheet(isPresented: $showBulkUpdate) {
            BulkUpdateSheet()
        }
    }

    @ViewBuilder
    private var content: some View {
        let groups = app.sessionList.projectGroups(fleet: app.fleet)
        if !app.sessionList.loaded {
            Spacer()
            ProgressView()
            Spacer()
        } else {
            List(selection: $selection) {
                if groups.isEmpty {
                    Section {
                        Text("No sessions yet — create one with the + button.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                // Projects are flat rows (header + sessions) in ONE
                // section — NOT per-project sections — so collapsed
                // projects are just compact rows without section chrome.
                Section {
                    ForEach(groups) { group in
                        projectHeader(group)
                            .listRowInsets(headerInsets)
                            .listRowSeparator(.hidden)
                        if !collapsed.contains(group.id) {
                            ForEach(group.sessions) { session in
                                sessionRow(session, archived: false)
                            }
                            if showArchived.contains(group.id) {
                                ForEach(group.archivedSessions) { session in
                                    sessionRow(session, archived: true)
                                }
                            }
                        }
                    }
                }

                Section {
                    ForEach(machines) { machine in
                        MachineRow(machine: machine)
                            .tag(DetailRoute.machine(machine.id))
                            .listRowInsets(machineRowInsets)
                            .listRowSeparator(.hidden)
                    }
                } header: {
                    HStack {
                        Text("Machines")
                        Spacer()
                        // Web parity: the machines-list kebab's
                        // "Update all sidecars…".
                        Menu {
                            Button("Update all sidecars…", systemImage: "arrow.down.circle") {
                                showBulkUpdate = true
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section {
                    HStack(spacing: 10) {
                        Image(systemName: "person.circle")
                        VStack(alignment: .leading, spacing: 1) {
                            Text(app.user?.email ?? "Account").font(.callout).lineLimit(1)
                            Text(app.user?.role ?? "").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .tag(DetailRoute.user)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.sidebar)
            .listSectionSpacing(.compact)
            .environment(\.defaultMinListRowHeight, minRowHeight)
            .refreshable { await app.refreshAll() }
        }
    }

    /// One session line with its actions — active rows archive, archived
    /// rows (dimmed) restore.
    @ViewBuilder
    private func sessionRow(_ session: SessionDTO, archived: Bool) -> some View {
        SessionRow(
            session: session,
            agent: app.fleet.agents[session.agentId],
            archived: archived
        )
        .tag(DetailRoute.session(session.id))
        .listRowInsets(rowInsets)
        .listRowSeparator(.hidden)
        .swipeActions(edge: .trailing) {
            if archived {
                Button("Unarchive", systemImage: "arrow.uturn.backward") {
                    unarchive(session)
                }
                .tint(.green)
            } else {
                Button("Archive", systemImage: "archivebox") {
                    archive(session)
                }
                .tint(.indigo)
            }
        }
        .contextMenu {
            Button("Rename", systemImage: "pencil") {
                renameText = session.title
                renameTarget = session
            }
            if archived {
                Button("Unarchive", systemImage: "arrow.uturn.backward") {
                    unarchive(session)
                }
            } else {
                Button("Archive", systemImage: "archivebox") {
                    archive(session)
                }
            }
        }
    }

    /// A compact, tappable project row (collapse toggle + eye + `+`),
    /// rendered as an ordinary list row rather than a section header.
    /// Long-press for management: rename (device-local), icon glyph
    /// (server-synced), archive-all-sessions.
    @ViewBuilder
    private func projectHeader(_ group: ProjectGroup) -> some View {
        HStack(spacing: 6) {
            Button {
                toggleCollapsed(group.id)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(collapsed.contains(group.id) ? 0 : 90))
                    projectGlyph(group)
                    Text(displayTitle(group))
                        .font(.caption).fontWeight(.medium).foregroundStyle(.secondary)
                    Text("\(group.sessions.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("Rename…", systemImage: "pencil") {
                    projectRenameText = projectNames[group.id] ?? ""
                    projectRenameTarget = group
                }
                if group.machineId != nil {
                    Button("Icon…", systemImage: "textformat") {
                        projectIconTarget = group
                    }
                }
                if !group.sessions.isEmpty {
                    Button("Archive all sessions…", systemImage: "archivebox", role: .destructive) {
                        projectArchiveTarget = group
                    }
                }
            }
            Spacer(minLength: 6)
            // The web's per-project eye: only offered when there is an
            // archive to reveal. Web semantics — showing = open eye in
            // emerald, hidden = slashed eye in neutral gray.
            if !group.archivedSessions.isEmpty {
                let showing = showArchived.contains(group.id)
                Button {
                    toggleShowArchived(group.id)
                } label: {
                    Image(systemName: showing ? "eye" : "eye.slash")
                        .font(.caption2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(showing ? Color(hex: 0x10B981) : Color(.tertiaryLabel))
            }
            if group.machineId != nil {
                Button {
                    newSessionProject = group
                } label: {
                    Image(systemName: "plus").font(.caption2)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var machines: [MachineDTO] {
        // Web parity (machineStore.sortOrder): offline sinks, then name.
        app.fleet.machines.values
            .filter { $0.archivedAt == nil }
            .sorted { a, b in
                let aOffline = a.status == .offline ? 1 : 0
                let bOffline = b.status == .offline ? 1 : 0
                if aOffline != bOffline { return aOffline < bOffline }
                return a.name.localizedCompare(b.name) == .orderedAscending
            }
    }

    /// The project's synced A–Z glyph (ProjectDTO.iconKey), or the
    /// default folder. Machine iconKeys are web-lucide names with no SF
    /// mapping — machines keep their computer glyph.
    @ViewBuilder
    private func projectGlyph(_ group: ProjectGroup) -> some View {
        if let letter = app.fleet.projects[group.id]?.iconKey, !letter.isEmpty {
            Text(letter.prefix(1).uppercased())
                .font(.system(size: 8, weight: .bold, design: .rounded))
                .frame(width: 13, height: 13)
                .background(Color.surface2, in: RoundedRectangle(cornerRadius: 3.5))
                .foregroundStyle(.secondary)
        } else {
            Image(systemName: "folder").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var renameAlertBinding: Binding<Bool> {
        Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )
    }

    private var projectRenameAlertBinding: Binding<Bool> {
        Binding(
            get: { projectRenameTarget != nil },
            set: { if !$0 { projectRenameTarget = nil } }
        )
    }

    private var projectArchiveDialogBinding: Binding<Bool> {
        Binding(
            get: { projectArchiveTarget != nil },
            set: { if !$0 { projectArchiveTarget = nil } }
        )
    }

    private func commitProjectRename() {
        guard let target = projectRenameTarget else { return }
        projectRenameTarget = nil
        setProjectName(target.id, projectRenameText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Cascade-archive the project's active sessions (web parity, minus
    /// agent archival — agents are invisible in this sidebar, and
    /// per-session unarchive keeps everything reversible).
    private func commitProjectArchive() {
        guard let target = projectArchiveTarget, let client = app.client else { return }
        projectArchiveTarget = nil
        let sessions = target.sessions
        Task {
            // Per-item, failure-tolerant, like the web's allSettled.
            for session in sessions {
                do {
                    app.sessionList.upsert(try await client.archiveSession(id: session.id))
                    if selection == .session(session.id) { selection = nil }
                } catch {
                    app.handleAPIError(error)
                }
            }
        }
    }

    private func commitRename() {
        guard let target = renameTarget else { return }
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renameTarget = nil
        guard !title.isEmpty, title != target.title, let client = app.client else { return }
        Task {
            do {
                app.sessionList.upsert(try await client.renameSession(id: target.id, title: title))
            } catch {
                app.handleAPIError(error)
            }
        }
    }

    private func archive(_ session: SessionDTO) {
        guard let client = app.client else { return }
        Task {
            do {
                let archived = try await client.archiveSession(id: session.id)
                app.sessionList.upsert(archived)
                if selection == .session(session.id) { selection = nil }
            } catch {
                app.handleAPIError(error)
            }
        }
    }

    private func unarchive(_ session: SessionDTO) {
        guard let client = app.client else { return }
        Task {
            do {
                app.sessionList.upsert(try await client.unarchiveSession(id: session.id))
            } catch {
                app.handleAPIError(error)
            }
        }
    }
}

/// A–Z glyph picker for a project (web's 6×5 letter grid + reset).
/// Server-synced via PATCH /projects/icon; every dashboard converges on
/// the project:upsert broadcast.
private struct ProjectIconSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let project: ProjectGroup

    @State private var busy = false
    @State private var errorMessage: String?

    private let letters = (65...90).map { String(UnicodeScalar($0)!) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 10) {
                    ForEach(letters, id: \.self) { letter in
                        Button {
                            save(letter)
                        } label: {
                            Text(letter)
                                .font(.system(.body, design: .rounded).weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 40)
                                .background(
                                    isCurrent(letter) ? Color.accentColor.opacity(0.2) : Color.surface1,
                                    in: RoundedRectangle(cornerRadius: 8)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                Button("Reset to folder") { save(nil) }
                    .font(.callout)
                if let errorMessage {
                    Text(errorMessage).font(.caption).foregroundStyle(.red)
                }
                Spacer()
            }
            .padding()
            .navigationTitle("Project icon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .disabled(busy)
        }
        .presentationDetents([.medium])
    }

    private func isCurrent(_ letter: String) -> Bool {
        app.fleet.projects[project.id]?.iconKey?.uppercased() == letter
    }

    private func save(_ letter: String?) {
        guard let client = app.client,
              let machineId = project.machineId,
              let workingDir = project.workingDir
        else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let dto = try await client.setProjectIcon(
                    machineId: machineId, workingDir: workingDir, iconKey: letter
                )
                app.fleet.upsert(project: dto)
                dismiss()
            } catch {
                app.handleAPIError(error)
                errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}

/// Fleet-wide sidecar update — the web's BulkUpdateModal: machine list
/// with per-row status, kicked off here, kept live by the
/// sidecar-update:batch-progress events.
private struct BulkUpdateSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var batchId: String?
    @State private var plan: [SidecarUpdatePlanEntry] = []
    @State private var starting = false
    @State private var errorMessage: String?

    private var machines: [MachineDTO] {
        app.fleet.machines.values
            .filter { $0.archivedAt == nil }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            List {
                if plan.isEmpty {
                    Section {
                        ForEach(machines) { machine in
                            HStack {
                                Text(machine.name)
                                Spacer()
                                Text(machine.status == .online ? machine.sidecarVersion : "offline")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    } footer: {
                        Text("Each online machine downloads the latest sidecar release, verifies it, and restarts itself. Offline machines are skipped.")
                    }
                } else {
                    Section("Plan") {
                        ForEach(plan, id: \.machineId) { entry in
                            planRow(entry)
                        }
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).font(.callout).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Update all sidecars")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(plan.isEmpty ? "Cancel" : "Close") { dismiss() }
                }
                if plan.isEmpty {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Update all") { start() }
                            .disabled(starting || machines.isEmpty)
                    }
                }
            }
            .onChange(of: app.lastSidecarBatchProgress) {
                guard let progress = app.lastSidecarBatchProgress,
                      progress.batchId == batchId
                else { return }
                plan = progress.plan
            }
        }
    }

    @ViewBuilder
    private func planRow(_ entry: SidecarUpdatePlanEntry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.machineName)
                HStack(spacing: 4) {
                    Text(entry.fromVersion)
                    if let toVersion = entry.toVersion {
                        Text("→ \(toVersion)")
                    }
                    if let error = entry.error {
                        Text(error).foregroundStyle(.red)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            statusBadge(entry.status)
        }
    }

    @ViewBuilder
    private func statusBadge(_ status: String) -> some View {
        switch status {
        case "in-progress":
            ProgressView().controlSize(.small)
        case "completed":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "failed":
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case "skipped-offline", "skipped-already-current":
            Text(status.replacingOccurrences(of: "skipped-", with: ""))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        default: // queued (or a future status — stays visible)
            Text(status).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func start() {
        guard let client = app.client else { return }
        starting = true
        errorMessage = nil
        Task {
            defer { starting = false }
            do {
                let accepted = try await client.updateAllSidecars()
                batchId = accepted.batchId
                plan = accepted.plan
            } catch {
                app.handleAPIError(error)
                errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}

private struct MachineRow: View {
    let machine: MachineDTO

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "desktopcomputer")
                .font(.caption)
                .foregroundStyle(machine.status == .online ? Color.green : Color.secondary)
                .frame(width: 16)
            Text(machine.name).font(.subheadline).lineLimit(1)
            Spacer(minLength: 6)
            Text("\(machine.agentCount)")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            Circle()
                .fill(machine.status == .online ? Color.green : Color.gray.opacity(0.4))
                .frame(width: 6, height: 6)
        }
    }
}

private struct SessionRow: View {
    let session: SessionDTO
    let agent: AgentDTO?
    var archived = false

    var body: some View {
        // Single compact line — icon · title · dot · time (web parity).
        // Archived rows render dimmed with an archivebox in the dot slot
        // (no live status to show).
        HStack(spacing: 8) {
            AgentTypeIcon(type: agent?.type ?? "custom", size: 13)
                .frame(width: 16)
                .opacity(archived ? 0.5 : 1)
            Text(session.title)
                .font(.subheadline)
                .fontWeight(!archived && session.unread ? .semibold : .regular)
                .foregroundStyle(archived ? .secondary : .primary)
                .lineLimit(1)
            Spacer(minLength: 6)
            if archived {
                Image(systemName: "archivebox")
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
            } else {
                SessionStatusDot(session: session)
            }
            Text(RelativeTime.short(iso: session.updatedAt))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
    }
}
