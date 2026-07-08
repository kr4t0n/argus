import SwiftUI
import ArgusKit

/// Sidebar: sessions grouped by project (the `(machineId, workingDir)`
/// pair), a machines section, and the account row — mirroring the web
/// sidebar's layout. Selection is a DetailRoute so session, machine,
/// and user rows all drive the same detail column.
struct SessionSidebar: View {
    @Environment(AppModel.self) private var app
    @Binding var selection: DetailRoute?

    @State private var renameTarget: SessionDTO?
    @State private var renameText = ""
    @State private var newSessionProject: ProjectGroup?
    @State private var showNewProject = false
    /// Collapsed project keys, persisted like the web's uiStore.expanded
    /// (default expanded — a key is present only when collapsed).
    @State private var collapsed = SessionSidebar.loadCollapsed()

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
        .sheet(item: $newSessionProject) { project in
            NewSessionSheet(project: project)
        }
        .sheet(isPresented: $showNewProject) {
            NewProjectSheet()
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
                ForEach(groups) { group in
                    Section {
                        if !collapsed.contains(group.id) {
                            ForEach(group.sessions) { session in
                                SessionRow(
                                    session: session,
                                    agent: app.fleet.agents[session.agentId]
                                )
                                .tag(DetailRoute.session(session.id))
                                .listRowInsets(EdgeInsets(top: 4, leading: 14, bottom: 4, trailing: 12))
                                .swipeActions(edge: .trailing) {
                                    Button("Archive", systemImage: "archivebox") {
                                        archive(session)
                                    }
                                    .tint(.indigo)
                                }
                                .contextMenu {
                                    Button("Rename", systemImage: "pencil") {
                                        renameText = session.title
                                        renameTarget = session
                                    }
                                    Button("Archive", systemImage: "archivebox") {
                                        archive(session)
                                    }
                                }
                            }
                        }
                    } header: {
                        HStack(spacing: 6) {
                            // Tap the label to collapse/expand the project.
                            Button {
                                toggleCollapsed(group.id)
                            } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundStyle(.tertiary)
                                        .rotationEffect(.degrees(collapsed.contains(group.id) ? 0 : 90))
                                    Image(systemName: "folder").font(.caption2)
                                    Text(group.title).font(.caption).fontWeight(.medium)
                                    Text("\(group.sessions.count)")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(.tertiary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Spacer()
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
                }

                Section("Machines") {
                    ForEach(machines) { machine in
                        MachineRow(machine: machine)
                            .tag(DetailRoute.machine(machine.id))
                            .listRowInsets(EdgeInsets(top: 4, leading: 14, bottom: 4, trailing: 12))
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
                }
            }
            .listStyle(.sidebar)
            .listSectionSpacing(.compact)
            .environment(\.defaultMinListRowHeight, 30)
            .refreshable { await app.refreshAll() }
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

    var body: some View {
        // Single compact line — icon · title · dot · time (web parity).
        HStack(spacing: 8) {
            AgentTypeIcon(type: agent?.type ?? "custom", size: 13)
                .frame(width: 16)
            Text(session.title)
                .font(.subheadline)
                .fontWeight(session.unread ? .semibold : .regular)
                .lineLimit(1)
            Spacer(minLength: 6)
            SessionStatusDot(session: session)
            Text(RelativeTime.short(iso: session.updatedAt))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
    }
}
