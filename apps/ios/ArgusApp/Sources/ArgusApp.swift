import SwiftUI
import ArgusKit

@main
struct ArgusApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .task { await app.bootstrap() }
                .onChange(of: scenePhase) { _, phase in
                    // iOS suspends the socket in the background; treat
                    // re-activation as a cold start (full snapshot +
                    // rejoin rooms) — the robust catch-up path.
                    if phase == .active { app.handleForeground() }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        switch app.phase {
        case .launching:
            ProgressView()
        case .loggedOut:
            LoginView()
        case .ready:
            MainSplitView()
        }
    }
}
