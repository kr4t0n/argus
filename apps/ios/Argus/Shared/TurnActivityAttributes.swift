import ActivityKit
import Foundation

/// Live Activity contract for a running turn — compiled into BOTH the
/// app (starts/updates/ends activities) and the widget extension
/// (renders them).
///
/// `ContentState`'s JSON keys are also the WIRE contract with the
/// server's live-activity pushes (`push.service.ts` sends
/// `content-state: {state, toolCount, lastTool}` — ActivityKit decodes
/// it with this struct's Codable). Do not rename fields without
/// changing the server.
struct TurnActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// "running" | "completed" | "failed"
        var state: String
        var toolCount: Int
        var lastTool: String

        var isRunning: Bool { state == "running" }
        var isFailed: Bool { state == "failed" }
    }

    var sessionId: String
    var sessionTitle: String
    var agentType: String
    /// Drives the on-device count-up timer — no pushes needed to tick.
    var startedAt: Date
}
