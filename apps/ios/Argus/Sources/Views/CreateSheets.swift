import SwiftUI
import ArgusKit

// Creation flows, mirroring the web's CreateProjectPopover /
// CreateAgentPopover(asSession): the user picks an adapter + title and
// the agent layer auto-vivifies behind the scenes (reuse an existing
// agent of that type in the project, else create one with an
// auto-generated name).

/// "＋" on a project row → new session inside that project.
struct NewSessionSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let project: ProjectGroup

    @State private var adapterType: AgentType = ""
    @State private var title = ""
    @State private var modelSelection = ModelSelection()
    @State private var busy = false
    @State private var errorMessage: String?

    private var machine: MachineDTO? {
        project.machineId.flatMap { app.fleet.machines[$0] }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Project", value: project.title)
                    if let machine {
                        LabeledContent("Machine", value: machine.name)
                    }
                }
                AdapterPickerSection(machine: machine, adapterType: $adapterType)
                Section("Session") {
                    TextField("Title (optional)", text: $title)
                    ModelRow(
                        machineId: project.machineId,
                        adapterType: adapterType,
                        selection: $modelSelection
                    )
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(busy || adapterType.isEmpty)
                }
            }
        }
        .onAppear {
            if adapterType.isEmpty {
                adapterType = machine?.availableAdapters.first?.type ?? ""
            }
        }
        .onChange(of: adapterType) {
            // Catalogs are per-CLI — a selection from the previous
            // adapter would be meaningless.
            modelSelection = ModelSelection()
        }
    }

    private func create() {
        guard let machineId = project.machineId else { return }
        busy = true
        errorMessage = nil
        Task {
            defer { busy = false }
            do {
                _ = try await app.createSession(
                    machineId: machineId,
                    workingDir: project.workingDir,
                    adapterType: adapterType,
                    title: title,
                    modelSelection: modelSelection
                )
                dismiss()
            } catch {
                app.handleAPIError(error)
                errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}

/// Sidebar "+" → new project: machine + working dir + first session.
/// The project row itself is derived — creating the first agent/session
/// in that directory is what brings it into existence.
struct NewProjectSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var machineId = ""
    @State private var workingDir = ""
    @State private var adapterType: AgentType = ""
    @State private var title = ""
    @State private var modelSelection = ModelSelection()
    @State private var busy = false
    @State private var errorMessage: String?

    private var machines: [MachineDTO] {
        app.fleet.machines.values
            .filter { $0.archivedAt == nil }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private var machine: MachineDTO? { app.fleet.machines[machineId] }

    var body: some View {
        NavigationStack {
            Form {
                Section("Machine") {
                    Picker("Machine", selection: $machineId) {
                        ForEach(machines) { machine in
                            Text(machine.name).tag(machine.id)
                        }
                    }
                }
                Section("Working directory") {
                    TextField("/home/me/projects/app", text: $workingDir)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                AdapterPickerSection(machine: machine, adapterType: $adapterType)
                Section("First session") {
                    TextField("Title (optional)", text: $title)
                    ModelRow(
                        machineId: machineId.isEmpty ? nil : machineId,
                        adapterType: adapterType,
                        selection: $modelSelection
                    )
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red).font(.callout) }
                }
            }
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(busy || machineId.isEmpty || adapterType.isEmpty || trimmedDir.isEmpty)
                }
            }
        }
        .onAppear {
            if machineId.isEmpty { machineId = machines.first?.id ?? "" }
        }
        .onChange(of: machineId) {
            adapterType = machine?.availableAdapters.first?.type ?? ""
            modelSelection = ModelSelection()
        }
        .onChange(of: adapterType) {
            modelSelection = ModelSelection()
        }
    }

    private var trimmedDir: String {
        workingDir.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func create() {
        busy = true
        errorMessage = nil
        Task {
            defer { busy = false }
            do {
                _ = try await app.createSession(
                    machineId: machineId,
                    workingDir: trimmedDir,
                    adapterType: adapterType,
                    title: title,
                    modelSelection: modelSelection
                )
                dismiss()
            } catch {
                app.handleAPIError(error)
                errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}

/// The create sheets' "Model" row: current selection as a summary,
/// pushing the shared catalog editor. The catalog is sourced from any
/// existing same-type agent on the target machine (catalogs are per-CLI
/// and stored per-agent; the session's own agent may not exist yet).
struct ModelRow: View {
    @Environment(AppModel.self) private var app
    let machineId: String?
    let adapterType: AgentType
    @Binding var selection: ModelSelection

    private var catalogAgentId: String? {
        guard let machineId, !adapterType.isEmpty else { return nil }
        return app.fleet.agents.values
            .first {
                $0.machineId == machineId && $0.type == adapterType && $0.archivedAt == nil
            }?
            .id
    }

    var body: some View {
        NavigationLink {
            ModelSelectionPage(catalogAgentId: catalogAgentId, selection: $selection)
        } label: {
            LabeledContent("Model") {
                Text(selection.summary)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
        }
        .disabled(adapterType.isEmpty)
    }
}

/// Adapter choice, filtered to what the sidecar discovered on that
/// machine's PATH — the same filter as the web's create popover.
struct AdapterPickerSection: View {
    let machine: MachineDTO?
    @Binding var adapterType: AgentType

    var body: some View {
        Section("Agent") {
            if let adapters = machine?.availableAdapters, !adapters.isEmpty {
                Picker("CLI", selection: $adapterType) {
                    ForEach(adapters, id: \.type) { adapter in
                        HStack {
                            Text(adapter.type)
                            if !adapter.version.isEmpty {
                                Text(adapter.version).foregroundStyle(.secondary)
                            }
                        }
                        .tag(adapter.type)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } else {
                Text("No CLI agents discovered on this machine.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
