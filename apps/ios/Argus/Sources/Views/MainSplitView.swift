import SwiftUI
import ArgusKit

/// The app shell: sidebar (projects → sessions, machines, account) +
/// routed detail column + optional right inspector — the same shape as
/// the web dashboard. NavigationSplitView collapses to a stack on
/// iPhone, where the inspector presents as a sheet.
struct MainSplitView: View {
    @Environment(AppModel.self) private var app

    /// Bound + `.balanced` so the system keeps a working sidebar toggle
    /// in the detail column when the sidebar is collapsed. Without these
    /// (unbound + `.automatic`) there was no way to reveal it again.
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        @Bindable var app = app
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SessionSidebar(selection: $app.route)
                .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 400)
        } detail: {
            detail
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
