import SwiftUI
import ArgusKit

// Creation flows, mirroring the web's creation popovers: the user
// picks an adapter + title and AppModel.createSession posts the
// project-first shape (machineId + workingDir + cliType) — the server
// upserts the Project row and routes by machine × CLI runner.

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

/// Machine panel "…" → new project: working dir + first session, on
/// that machine. The project row is created server-side by the
/// project-first session POST.
///
/// Web parity: projects are created FROM a machine (the machine list's
/// hover "+"), never from a global button that then asks which machine —
/// the machine is the natural entry point, so `machine` is passed in and
/// its picker is a locked display row.
struct NewProjectSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    /// The machine this project lives on — always supplied by the
    /// caller (MachineView). Kept as a field rather than re-picked so
    /// the sheet can't create a project on a machine the user isn't
    /// looking at.
    let machine: MachineDTO

    @State private var workingDir = ""
    @State private var adapterType: AgentType = ""
    @State private var title = ""
    @State private var modelSelection = ModelSelection()
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Machine") {
                    LabeledContent("Machine", value: machine.name)
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
                        machineId: machine.id,
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
                        .disabled(busy || adapterType.isEmpty || trimmedDir.isEmpty)
                }
            }
        }
        .onAppear {
            if adapterType.isEmpty {
                adapterType = machine.availableAdapters.first?.type ?? ""
            }
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
                    machineId: machine.id,
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
/// pushing the shared catalog editor. Both the machine and the adapter
/// type are known right here, and catalogs are keyed (machineId,
/// cliType) since Phase 2 — resolvable before any session exists.
struct ModelRow: View {
    let machineId: String?
    let adapterType: AgentType
    @Binding var selection: ModelSelection

    var body: some View {
        NavigationLink {
            ModelSelectionPage(machineId: machineId, cliType: adapterType, selection: $selection)
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
