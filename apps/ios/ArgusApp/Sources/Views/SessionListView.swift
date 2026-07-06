import SwiftUI
import ArgusKit

/// Home screen: sessions grouped by project — the `(machineId,
/// workingDir)` pair — exactly like the web sidebar. The agent shows
/// only as a leading brand icon on each row.
struct SessionListView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
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
            .navigationDestination(for: String.self) { sessionId in
                SessionView(sessionId: sessionId)
            }
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
            List {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.sessions) { session in
                            NavigationLink(value: session.id) {
                                SessionRow(
                                    session: session,
                                    agent: app.fleet.agents[session.agentId]
                                )
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
            .listStyle(.insetGrouped)
            .refreshable { await app.refreshAll() }
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
