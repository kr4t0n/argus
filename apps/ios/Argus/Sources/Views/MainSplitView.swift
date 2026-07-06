import SwiftUI
import ArgusKit

/// The app shell: sidebar (projects → sessions, machines, account) +
/// routed detail column + optional right inspector — the same shape as
/// the web dashboard. NavigationSplitView collapses to a stack on
/// iPhone, where the inspector presents as a sheet.
struct MainSplitView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationSplitView {
            SessionSidebar(selection: $app.route)
        } detail: {
            switch app.route {
            case .session(let sessionId):
                SessionView(sessionId: sessionId)
                    // Force fresh view identity (and @State) per session
                    // — detail swaps in place on iPad.
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
}
