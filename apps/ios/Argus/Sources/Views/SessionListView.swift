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
                        ForEach(group.sessions) { session in
                            SessionRow(
                                session: session,
                                agent: app.fleet.agents[session.agentId]
                            )
                            .tag(DetailRoute.session(session.id))
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
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: "folder")
                            Text(group.title)
                            if !group.machineName.isEmpty {
                                Text("· \(group.machineName)")
                                    .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            // Project-scoped "+" — the web's project-row
                            // hover action.
                            if group.machineId != nil {
                                Button {
                                    newSessionProject = group
                                } label: {
                                    Image(systemName: "plus")
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .font(.caption)
                    }
                }

                Section("Machines") {
                    ForEach(machines) { machine in
                        MachineRow(machine: machine)
                            .tag(DetailRoute.machine(machine.id))
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
            .refreshable { await app.refreshAll() }
        }
    }

    private var machines: [MachineDTO] {
        app.fleet.machines.values
            .filter { $0.archivedAt == nil }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
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
        HStack(spacing: 10) {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(machine.status == .online ? Color.green : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(machine.name).font(.callout).lineLimit(1)
                Text("\(machine.agentCount) agent\(machine.agentCount == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Circle()
                .fill(machine.status == .online ? Color.green : Color.gray.opacity(0.4))
                .frame(width: 7, height: 7)
        }
    }
}

private struct SessionRow: View {
    let session: SessionDTO
    let agent: AgentDTO?

    var body: some View {
        HStack(spacing: 10) {
            AgentTypeIcon(type: agent?.type ?? "custom")
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .font(.body)
                    .fontWeight(session.unread ? .semibold : .regular)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if session.status == .active {
                        Text("running")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    Text(RelativeTime.label(iso: session.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
            SessionStatusDot(session: session)
        }
        .padding(.vertical, 2)
    }
}
