import SwiftUI
import ArgusKit

/// The app shell: sidebar (projects → sessions, machines, account) +
/// routed detail column + optional right inspector — the same shape as
/// the web dashboard. NavigationSplitView collapses to a stack on
/// iPhone, where the inspector presents as a sheet.
struct MainSplitView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// Bound so a collapsed sidebar can be revealed again — the system
    /// doesn't always surface a reveal control in the detail column.
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        @Bindable var app = app
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SessionSidebar(selection: $app.route)
                .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 400)
        } detail: {
            detail
                .toolbar {
                    // iPad: when the sidebar is hidden there's otherwise no
                    // way back. iPhone uses stack nav, so skip it there.
                    if sizeClass == .regular, columnVisibility == .detailOnly {
                        ToolbarItem(placement: .topBarLeading) {
                            Button {
                                withAnimation { columnVisibility = .all }
                            } label: {
                                Image(systemName: "sidebar.leading")
                            }
                            .accessibilityLabel("Show sidebar")
                        }
                    }
                }
        }
        .navigationSplitViewStyle(.balanced)
    }

    @ViewBuilder
    private var detail: some View {
        @Bindable var app = app
        switch app.route {
        case .session(let sessionId):
            SessionView(sessionId: sessionId)
                // Force fresh view identity (and @State) per session —
                // detail swaps in place on iPad.
                .id(sessionId)
                .inspector(isPresented: $app.inspectorPresented) {
                    InspectorPane(sessionId: sessionId)
                        .inspectorColumnWidth(min: 280, ideal: 340, max: 480)
                }
        case .machine(let machineId):
            MachineView(machineId: machineId)
                .id(machineId)
        case .user:
            UserPanelView()
        case nil:
            ContentUnavailableView(
                "Select a session",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Pick a session from the sidebar.")
            )
        }
    }
}
