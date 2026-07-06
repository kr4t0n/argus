import SwiftUI
import ArgusKit

/// Session-default model picker — the iOS counterpart of the web's
/// SessionModelChip/ModelPicker. Catalog-driven per CLI, with facet
/// controls (effort / 1M context / fast tier) shown only when the
/// selected entry declares them, plus a free-text custom id escape
/// hatch. Saving PATCHes the session default; per-turn overrides are a
/// later phase.
struct ModelPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let session: SessionDTO
    let agent: AgentDTO?

    @State private var catalog: ModelCatalogResponse?
    @State private var loadError: String?
    @State private var selection = ModelSelection()
    @State private var customModel = ""
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    selectableRow(title: "CLI default", subtitle: nil, isSelected: selection.model == nil && customModel.isEmpty) {
                        selection = ModelSelection()
                        customModel = ""
                    }
                }

                if let catalog {
                    Section("Models") {
                        ForEach(catalog.models) { entry in
                            selectableRow(
                                title: entry.family.map { "\($0) · \(entry.variantLabel ?? entry.displayName)" }
                                    ?? entry.displayName,
                                subtitle: entry.isDefault == true ? "CLI default" : entry.description,
                                isSelected: selection.model == entry.id && customModel.isEmpty
                            ) {
                                customModel = ""
                                selection.model = entry.id
                                // Reset facets to the entry's defaults.
                                selection.effort = entry.facets?.effort?.defaultLevel
                                selection.context = nil
                                selection.speed = nil
                            }
                        }
                    }

                    if let facets = selectedEntry?.facets {
                        Section("Options") {
                            if let effort = facets.effort {
                                Picker("Effort", selection: effortBinding(default: effort.defaultLevel)) {
                                    ForEach(effort.levels, id: \.self) { level in
                                        Text(level).tag(level)
                                    }
                                }
                            }
                            if facets.context?.options.contains("1m") == true {
                                Toggle("1M context window", isOn: contextBinding)
                            }
                            if facets.speed?.options.contains("fast") == true {
                                Toggle("Fast service tier", isOn: speedBinding)
                            }
                        }
                    }
                } else if let loadError {
                    Section {
                        Text(loadError).foregroundStyle(.red).font(.callout)
                    }
                } else {
                    Section { ProgressView().frame(maxWidth: .infinity) }
                }

                Section("Custom") {
                    TextField("Model id (free text)", text: $customModel)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onChange(of: customModel) {
                            if !customModel.isEmpty {
                                selection = ModelSelection(model: customModel)
                            }
                        }
                }
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }.disabled(saving)
                }
            }
            .task { await loadCatalog() }
        }
    }

    private var selectedEntry: ModelCatalogEntry? {
        guard customModel.isEmpty, let model = selection.model else { return nil }
        return catalog?.models.first { $0.id == model }
    }

    private func selectableRow(
        title: String,
        subtitle: String?,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(.primary)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(.tint)
                }
            }
        }
    }

    private func effortBinding(default defaultLevel: String) -> Binding<String> {
        Binding(
            get: { selection.effort ?? defaultLevel },
            set: { selection.effort = $0 }
        )
    }

    private var contextBinding: Binding<Bool> {
        Binding(
            get: { selection.context == "1m" },
            set: { selection.context = $0 ? "1m" : nil }
        )
    }

    private var speedBinding: Binding<Bool> {
        Binding(
            get: { selection.speed == "fast" },
            set: { selection.speed = $0 ? "fast" : nil }
        )
    }

    private func loadCatalog() async {
        guard let client = app.client, let agent else {
            loadError = "Agent unavailable"
            return
        }
        selection = session.modelSelection ?? ModelSelection()
        if let model = selection.model {
            customModel = "" // resolved below if it's a catalog id
            do {
                catalog = try await client.getModelCatalog(agentId: agent.id)
                if catalog?.models.contains(where: { $0.id == model }) != true {
                    customModel = model
                }
            } catch {
                app.handleAPIError(error)
                loadError = (error as? APIError)?.message ?? error.localizedDescription
            }
        } else {
            do {
                catalog = try await client.getModelCatalog(agentId: agent.id)
            } catch {
                app.handleAPIError(error)
                loadError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }

    private func save() {
        guard let client = app.client else { return }
        saving = true
        let toSave = selection.isEmpty ? nil : selection
        Task {
            defer { saving = false }
            do {
                let updated = try await client.setSessionModel(id: session.id, modelSelection: toSave)
                app.sessionList.upsert(updated)
                dismiss()
            } catch {
                app.handleAPIError(error)
                loadError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}
