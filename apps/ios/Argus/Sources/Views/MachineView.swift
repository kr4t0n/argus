import SwiftUI
import ArgusKit

/// Machine detail — the iOS counterpart of the web's MachinePanel: host
/// metadata, discovered adapters, the machine's projects (Phase 4 — the
/// unit of work is the project, not the agent), sidecar version +
/// remote update, and machine delete.
struct MachineView: View {
    @Environment(AppModel.self) private var app
    let machineId: String

    @State private var versionInfo: SidecarVersionInfo?
    @State private var updateNotice: String?
    @State private var showNewProject = false
    @State private var showDeleteMachine = false

    private var machine: MachineDTO? { app.fleet.machines[machineId] }

    /// Non-archived projects on this machine, from the server project
    /// store. Newest-updated first by the most recent session.
    private var projects: [ProjectDTO] {
        app.fleet.projects.values
            .filter { $0.machineId == machineId && $0.archivedAt == nil }
            .sorted { ($0.name ?? $0.workingDir).localizedCaseInsensitiveCompare($1.name ?? $1.workingDir) == .orderedAscending }
    }

    var body: some View {
        Group {
            if let machine {
                List {
                    hostSection(machine)
                    adaptersSection(machine)
                    projectsSection
                }
                .navigationTitle(machine.name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
                .refreshable { await reload() }
            } else {
                ContentUnavailableView("Machine not found", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            }
        }
        .task { await reload() }
        .sheet(isPresented: $showNewProject) {
            if let machine {
                NewProjectSheet(machine: machine)
            }
        }
        .confirmationDialog(
            "Remove this machine from the dashboard? Sessions stay in the database; the removal is sticky even if the sidecar keeps running.",
            isPresented: $showDeleteMachine,
            titleVisibility: .visible
        ) {
            Button("Remove machine", role: .destructive) { deleteMachine() }
        }
    }

    // MARK: Sections

    private func hostSection(_ machine: MachineDTO) -> some View {
        Section("Host") {
            LabeledContent("Status") {
                Text(machine.status.rawValue)
                    .foregroundStyle(machine.status == .online ? .green : .secondary)
            }
            LabeledContent("Hostname", value: machine.hostname)
            LabeledContent("OS / arch", value: "\(machine.os) / \(machine.arch)")
            LabeledContent("Sidecar") {
                HStack(spacing: 6) {
                    Text(machine.sidecarVersion)
                    if versionInfo?.updateAvailable == true {
                        Text("→ \(versionInfo?.latest ?? "")")
                            .foregroundStyle(.green)
                    }
                }
            }
            LabeledContent("Last seen", value: RelativeTime.label(iso: machine.lastSeenAt))
            if let updateNotice {
                Text(updateNotice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func adaptersSection(_ machine: MachineDTO) -> some View {
        Section("Supports") {
            if machine.availableAdapters.isEmpty {
                Text("No CLI agents discovered on PATH.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(machine.availableAdapters, id: \.type) { adapter in
                    HStack(spacing: 10) {
                        AgentTypeIcon(type: adapter.type)
                            .frame(width: 18)
                        Text(adapter.type)
                        Spacer()
                        Text(adapter.version.isEmpty ? adapter.binary : adapter.version)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var projectsSection: some View {
        Section("Projects") {
            if projects.isEmpty {
                Text("No projects on this machine yet — create one above.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(projects) { project in
                    let recent = app.sessionList.sessions.values
                        .filter { $0.projectId == project.id && $0.archivedAt == nil }
                        .max { $0.updatedAt < $1.updatedAt }
                    Button {
                        if let recent { app.route = .session(recent.id) }
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "folder")
                                .frame(width: 18)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(project.name ?? project.workingDir).font(.callout)
                                Text(project.workingDir)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(recent == nil)
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("New project…", systemImage: "folder.badge.plus") { showNewProject = true }
                Button("Update sidecar", systemImage: "arrow.down.circle") { updateSidecar() }
                    .disabled(machine?.status != .online)
                Divider()
                Button("Remove machine…", systemImage: "trash", role: .destructive) {
                    showDeleteMachine = true
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    // MARK: Actions

    private func reload() async {
        guard let client = app.client else { return }
        // Best-effort: a rate-limited GitHub lookup or offline host must
        // not blank the version badge.
        versionInfo = try? await client.getSidecarVersion(machineId: machineId)
    }

    private func updateSidecar() {
        guard let client = app.client else { return }
        updateNotice = nil
        Task {
            do {
                let accepted = try await client.updateSidecar(machineId: machineId)
                // Completion arrives as machine:upsert with the new
                // version once the sidecar re-registers.
                updateNotice = "Update requested (from \(accepted.fromVersion)) — the sidecar restarts itself."
            } catch {
                app.handleAPIError(error)
                updateNotice = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }

    private func deleteMachine() {
        guard let client = app.client else { return }
        Task {
            do {
                try await client.deleteMachine(id: machineId)
                app.fleet.removeMachine(id: machineId)
                if app.route == .machine(machineId) { app.route = nil }
                await app.refreshAll()
            } catch {
                app.handleAPIError(error)
            }
        }
    }
}
