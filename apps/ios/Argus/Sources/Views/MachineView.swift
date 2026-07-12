import SwiftUI
import ArgusKit

/// Machine detail — the iOS counterpart of the web's MachinePanel: host
/// metadata, discovered adapters, agent roster (with destroy), sidecar
/// version + remote update, and machine delete.
struct MachineView: View {
    @Environment(AppModel.self) private var app
    let machineId: String

    @State private var agents: [AgentDTO] = []
    @State private var versionInfo: SidecarVersionInfo?
    @State private var updateNotice: String?
    @State private var showNewAgent = false
    @State private var destroyTarget: AgentDTO?
    @State private var showDeleteMachine = false

    private var machine: MachineDTO? { app.fleet.machines[machineId] }

    var body: some View {
        Group {
            if let machine {
                List {
                    hostSection(machine)
                    adaptersSection(machine)
                    agentsSection
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
        .sheet(isPresented: $showNewAgent) {
            if let machine {
                NewAgentSheet(machine: machine) { created in
                    agents.append(created)
                }
            }
        }
        .confirmationDialog(
            "Destroy \(destroyTarget?.name ?? "agent")? This permanently deletes the agent and its session history.",
            isPresented: destroyDialogBinding,
            titleVisibility: .visible
        ) {
            Button("Destroy agent", role: .destructive) { destroyConfirmed() }
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

    private var agentsSection: some View {
        Section("Agents") {
            if agents.isEmpty {
                Text("No agents on this machine yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(agents) { agent in
                    HStack(spacing: 10) {
                        AgentTypeIcon(type: agent.type)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.name).font(.callout)
                            if let workingDir = agent.workingDir {
                                Text(workingDir)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                    .truncationMode(.head)
                            }
                        }
                        Spacer()
                        Text(agent.status.rawValue)
                            .font(.caption2)
                            .foregroundStyle(agent.status == .online ? .green : .secondary)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Destroy", systemImage: "trash", role: .destructive) {
                            destroyTarget = agent
                        }
                    }
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("New agent…", systemImage: "plus") { showNewAgent = true }
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

    private var destroyDialogBinding: Binding<Bool> {
        Binding(
            get: { destroyTarget != nil },
            set: { if !$0 { destroyTarget = nil } }
        )
    }

    private func reload() async {
        guard let client = app.client else { return }
        do {
            agents = try await client.listMachineAgents(machineId: machineId)
                .filter { $0.archivedAt == nil }
        } catch {
            app.handleAPIError(error)
        }
        // Best-effort: a rate-limited GitHub lookup or offline host must
        // not blank the agent roster.
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

    private func destroyConfirmed() {
        guard let client = app.client, let target = destroyTarget else { return }
        destroyTarget = nil
        Task {
            do {
                try await client.destroyAgent(machineId: machineId, agentId: target.id)
                agents.removeAll { $0.id == target.id }
                app.fleet.removeAgent(id: target.id)
            } catch {
                app.handleAPIError(error)
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

/// Full-control agent creation (the machine-panel flow: explicit name,
/// working dir, terminal opt-in) — unlike the sidebar's auto-vivify.
private struct NewAgentSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let machine: MachineDTO
    let onCreated: (AgentDTO) -> Void

    @State private var adapterType: AgentType = ""
    @State private var name = ""
    @State private var autoName = ""
    @State private var workingDir = ""
    @State private var supportsTerminal = false
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                AdapterPickerSection(machine: machine, adapterType: $adapterType)
                Section("Agent") {
                    TextField("Name", text: $name)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    TextField("Working directory (optional)", text: $workingDir)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    Toggle("Attach interactive terminal", isOn: $supportsTerminal)
                }
                if supportsTerminal {
                    Section {
                        Text("The terminal grants every dashboard user shell access on this host — enable only where that trust model is acceptable.")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
                }
            }
            .navigationTitle("New agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(busy || adapterType.isEmpty || trimmedName.isEmpty)
                }
            }
        }
        .onAppear {
            if adapterType.isEmpty {
                adapterType = machine.availableAdapters.first?.type ?? ""
            }
            if name.isEmpty { regenerateName() }
        }
        .onChange(of: adapterType) {
            // Refresh the suggestion only while the user hasn't typed
            // their own name.
            if name.isEmpty || name == autoName { regenerateName() }
        }
    }

    private func regenerateName() {
        autoName = defaultName
        name = autoName
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var defaultName: String {
        "\(adapterType)-\(String(UUID().uuidString.prefix(4)).lowercased())"
    }

    private func create() {
        guard let client = app.client else { return }
        busy = true
        errorMessage = nil
        let dir = workingDir.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { busy = false }
            do {
                let agent = try await client.createAgent(
                    machineId: machine.id,
                    CreateAgentRequest(
                        name: trimmedName,
                        type: adapterType,
                        workingDir: dir.isEmpty ? nil : dir,
                        supportsTerminal: supportsTerminal ? true : nil
                    )
                )
                app.fleet.upsert(agent: agent)
                onCreated(agent)
                dismiss()
            } catch {
                app.handleAPIError(error)
                errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}
