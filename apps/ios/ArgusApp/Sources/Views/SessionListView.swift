import SwiftUI
import ArgusKit

/// Sidebar: sessions grouped by project — the `(machineId, workingDir)`
/// pair — exactly like the web sidebar. The agent shows only as a
/// leading brand icon on each row. Selection drives the split view's
/// detail column (and pushes on iPhone).
struct SessionSidebar: View {
    @Environment(AppModel.self) private var app
    @Binding var selection: String?

    @State private var renameTarget: SessionDTO?
    @State private var renameText = ""

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
                    if let user = app.user {
                        Text(user.email)
                    }
                    Button("Log out", role: .destructive) { app.logOut() }
                } label: {
                    Image(systemName: "person.circle")
                }
            }
        }
        .alert("Rename session", isPresented: renameAlertBinding) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Rename") { commitRename() }
        }
    }

    @ViewBuilder
    private var content: some View {
        let groups = app.sessionList.projectGroups(fleet: app.fleet)
        if !app.sessionList.loaded {
            Spacer()
            ProgressView()
            Spacer()
        } else if groups.isEmpty {
            ContentUnavailableView(
                "No sessions",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Create a session from the web dashboard to see it here.")
            )
        } else {
            List(selection: $selection) {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.sessions) { session in
                            SessionRow(
                                session: session,
                                agent: app.fleet.agents[session.agentId]
                            )
                            .tag(session.id)
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
                        }
                        .font(.caption)
                    }
                }
            }
            .listStyle(.sidebar)
            .refreshable { await app.refreshAll() }
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
                if selection == session.id { selection = nil }
            } catch {
                app.handleAPIError(error)
            }
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
