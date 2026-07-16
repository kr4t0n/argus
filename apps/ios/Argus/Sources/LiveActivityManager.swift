import ActivityKit
import Foundation
import ArgusKit

/// Owns the lock-screen Live Activities for running turns.
///
/// Lifecycle: the app STARTS an activity (ActivityKit requires
/// foreground) when a turn begins in a session the user is watching or
/// submitted from this device. While foregrounded, updates are local
/// (throttled); each activity's push token registers with the server,
/// which takes over with 'liveactivity' APNs updates once the app
/// backgrounds — including the 'end' that resolves the card to ✓/✗.
/// The app also ends locally when it sees the terminal status first,
/// and reconciles strays on foreground (activities survive app
/// relaunches; `Activity.activities` re-adopts them).
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    /// Wired by AppModel: POST /me/live-activities.
    var register: ((_ sessionId: String, _ tokenHex: String) async -> Void)?
    /// Wired by AppModel: DELETE /me/live-activities/:token.
    var unregister: ((_ tokenHex: String) async -> Void)?

    private var activities: [String: Activity<TurnActivityAttributes>] = [:]
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    private var tokenHex: [String: String] = [:]
    private var counters: [String: (count: Int, lastTool: String)] = [:]
    private var lastLocalPush: [String: Date] = [:]

    private init() {}

    var isAvailable: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Idempotent — a session gets at most one activity.
    func start(session: SessionDTO, agentType: AgentType) {
        guard isAvailable, activities[session.id] == nil else { return }
        let attributes = TurnActivityAttributes(
            sessionId: session.id,
            sessionTitle: session.title,
            agentType: agentType,
            startedAt: Date()
        )
        let initial = ActivityContent(
            state: TurnActivityAttributes.ContentState(state: "running", toolCount: 0, lastTool: ""),
            staleDate: nil
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: initial,
                pushType: .token
            )
            adopt(activity, sessionId: session.id)
        } catch {
            // Activities disabled system-wide / per-app — silently fine.
        }
    }

    /// Track an existing activity (fresh start OR re-adopted after an
    /// app relaunch) and stream its push tokens to the server.
    private func adopt(_ activity: Activity<TurnActivityAttributes>, sessionId: String) {
        activities[sessionId] = activity
        tokenTasks[sessionId]?.cancel()
        tokenTasks[sessionId] = Task { [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                await MainActor.run { self?.tokenHex[sessionId] = hex }
                await self?.register?(sessionId, hex)
            }
        }
    }

    /// Local update while foregrounded — counters track every tool
    /// chunk; the visible update is throttled to ~1/2s.
    func noteChunk(sessionId: String, chunk: ResultChunk) {
        guard chunk.kind == .tool, let activity = activities[sessionId] else { return }
        var counter = counters[sessionId] ?? (0, "")
        counter.count += 1
        let firstLine = (chunk.content ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", maxSplits: 1)
            .first.map(String.init) ?? ""
        counter.lastTool = firstLine.isEmpty
            ? (chunk.meta?["tool"]?.string ?? "tool")
            : firstLine
        counters[sessionId] = counter

        let now = Date()
        if let last = lastLocalPush[sessionId], now.timeIntervalSince(last) < 2 { return }
        lastLocalPush[sessionId] = now
        let content = ActivityContent(
            state: TurnActivityAttributes.ContentState(
                state: "running", toolCount: counter.count, lastTool: counter.lastTool
            ),
            staleDate: nil
        )
        Task { await activity.update(content) }
    }

    /// Resolve and tear down. The card lingers a few minutes (matching
    /// the server-push dismissal) so a just-finished turn is glanceable.
    func end(sessionId: String, failed: Bool) {
        guard let activity = activities.removeValue(forKey: sessionId) else { return }
        tokenTasks.removeValue(forKey: sessionId)?.cancel()
        let counter = counters.removeValue(forKey: sessionId) ?? (0, "")
        lastLocalPush[sessionId] = nil
        let hex = tokenHex.removeValue(forKey: sessionId)
        let final = ActivityContent(
            state: TurnActivityAttributes.ContentState(
                state: failed ? "failed" : "completed",
                toolCount: counter.count,
                lastTool: counter.lastTool
            ),
            staleDate: nil
        )
        Task {
            await activity.end(final, dismissalPolicy: .after(Date().addingTimeInterval(240)))
            if let hex {
                await unregister?(hex)
            }
        }
    }

    /// Foreground reconcile: adopt activities that survived a relaunch,
    /// end any whose session is no longer running (the server's end
    /// push normally handles this, but only when APNs is configured).
    func reconcile(sessionStatus: (String) -> SessionStatus?) {
        for activity in Activity<TurnActivityAttributes>.activities {
            let sessionId = activity.attributes.sessionId
            if activities[sessionId] == nil {
                adopt(activity, sessionId: sessionId)
            }
            let status = sessionStatus(sessionId)
            if status != .active {
                end(sessionId: sessionId, failed: status == .failed)
            }
        }
    }

    func endAll() {
        for sessionId in Array(activities.keys) {
            end(sessionId: sessionId, failed: false)
        }
    }
}
