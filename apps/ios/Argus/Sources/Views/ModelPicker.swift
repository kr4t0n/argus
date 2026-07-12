import SwiftUI
import ArgusKit

// Model selection UI — the iOS counterpart of the web's ModelPicker /
// SessionModelChip. One catalog-driven editor, two containers:
//   - ModelPickerSheet changes an EXISTING session's default (saves via
//     PATCH /sessions/:id/model on confirm);
//   - the create sheets push ModelSelectionPage behind a "Model" row and
//     apply the selection at creation (web new-session dialog parity).

extension ModelSelection {
    /// Short human summary, e.g. "opus · high · 1M" / "CLI default".
    var summary: String {
        var parts: [String] = []
        if let model { parts.append(model) }
        if let effort { parts.append(effort) }
        if context == "1m" { parts.append("1M") }
        if speed == "fast" { parts.append("fast") }
        return parts.isEmpty ? "CLI default" : parts.joined(separator: " · ")
    }
}

/// The editor's Form sections. Catalog comes from `catalogAgentId` —
/// for existing sessions that's the session's agent; at creation time
/// it's any same-type agent on the target machine (catalogs are per-CLI,
/// stored per-agent). nil = the CLI never ran there → custom-id only.
struct ModelSelectionForm: View {
    @Environment(AppModel.self) private var app
    let catalogAgentId: String?
    @Binding var selection: ModelSelection

    @State private var catalog: ModelCatalogResponse?
    @State private var loadError: String?
    @State private var customModel = ""

    var body: some View {
        Section {
            selectableRow(
                title: "CLI default",
                subtitle: nil,
                isSelected: selection.model == nil && customModel.isEmpty
            ) {
                selection = ModelSelection()
                customModel = ""
            }
            // .task on a row (not the Section) — fires once when the
            // form appears, which is when the catalog should load.
            .task { await loadCatalog() }
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
        } else if catalogAgentId == nil {
            Section {
                Text("No agent of this type on the machine yet — the model catalog appears after the first one runs. A custom model id below still works.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
        guard catalog == nil, let catalogAgentId, let client = app.client else { return }
        do {
            catalog = try await client.getModelCatalog(agentId: catalogAgentId)
            // A pre-set model id that isn't in the catalog is a custom id.
            if let model = selection.model,
               catalog?.models.contains(where: { $0.id == model }) != true {
                customModel = model
            }
        } catch {
            app.handleAPIError(error)
            loadError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}

/// Pushed page for the create sheets' "Model" row. The binding applies
/// live; it takes effect when the session is created.
struct ModelSelectionPage: View {
    let catalogAgentId: String?
    @Binding var selection: ModelSelection

    var body: some View {
        Form {
            ModelSelectionForm(catalogAgentId: catalogAgentId, selection: $selection)
        }
        .navigationTitle("Model")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Change an existing session's default model — the ⋯ menu's "Model…"
/// sheet. Saves via PATCH /sessions/:id/model on confirm.
struct ModelPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let session: SessionDTO
    let agent: AgentDTO?

    @State private var selection = ModelSelection()
    @State private var seeded = false
    @State private var saving = false
    @State private var saveError: String?

    var body: some View {
        NavigationStack {
            Form {
                ModelSelectionForm(catalogAgentId: agent?.id, selection: $selection)
                if let saveError {
                    Section { Text(saveError).foregroundStyle(.red).font(.callout) }
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
            .onAppear {
                // Seed once — onAppear can refire (sheet gestures).
                if !seeded {
                    seeded = true
                    selection = session.modelSelection ?? ModelSelection()
                }
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
                saveError = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}
