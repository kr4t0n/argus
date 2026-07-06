import SwiftUI
import ArgusKit

@main
struct ArgusApp: App {
    // Remote-notification registration callbacks only arrive via a
    // UIApplicationDelegate.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .task {
                    // Delegate must be set before any notification tap
                    // can be delivered (incl. cold-launch taps).
                    PushManager.shared.configure()
                    await app.bootstrap()
                }
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
