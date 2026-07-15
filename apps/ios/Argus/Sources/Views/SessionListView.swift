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
        // No global "new project" button: projects are created from the
        // machine they live on (machine panel → "…" → New project), which
        // is also where the web puts it. A global button would just have
        // to ask which machine anyway.
        .alert("Rename session", isPresented: renameAlertBinding) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Rename") { commitRename() }
        }
        .sheet(item: $newSessionProject) { project in
            NewSessionSheet(project: project)
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

                Section("Machines") {
                    ForEach(machines) { machine in
                        MachineRow(machine: machine)
                            .tag(DetailRoute.machine(machine.id))
                            .listRowInsets(machineRowInsets)
                            .listRowSeparator(.hidden)
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
            agent: session.agentId.flatMap { app.fleet.agents[$0] },
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
                    Image(systemName: "folder").font(.caption2).foregroundStyle(.secondary)
                    Text(group.title).font(.caption).fontWeight(.medium).foregroundStyle(.secondary)
                    Text("\(group.sessions.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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

    private var renameAlertBinding: Binding<Bool> {
        Binding(
            get: { renameTarget != nil },
            set: { if !$0 { renameTarget = nil } }
        )
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
        // (no live status to show). The icon keys off the session's
        // pinned cliType (Phase 1); the agent row only covers
        // pre-backfill sessions.
        HStack(spacing: 8) {
            AgentTypeIcon(type: session.cliType ?? agent?.type ?? "custom", size: 13)
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
