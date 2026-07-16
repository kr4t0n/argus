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
    /// Armed while an update sits suppressed inside the throttle window;
    /// fires at window expiry with the then-current counters.
    private var pendingFlush: [String: Task<Void, Never>] = [:]

    /// Min interval between visible local updates (leading edge; a
    /// trailing flush covers whatever a burst leaves behind).
    private static let throttleWindow: TimeInterval = 2

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
    /// chunk; the visible update is throttled to ~1/2s (leading edge),
    /// with a trailing flush so a burst's final state always renders.
    func noteChunk(sessionId: String, chunk: ResultChunk) {
        guard chunk.kind == .tool, activities[sessionId] != nil else { return }
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
        if let last = lastLocalPush[sessionId] {
            let elapsed = now.timeIntervalSince(last)
            if elapsed < Self.throttleWindow {
                scheduleTrailingFlush(sessionId: sessionId, in: Self.throttleWindow - elapsed)
                return
            }
        }
        pushRunningState(sessionId: sessionId)
    }

    /// Trailing-edge flush: chunks suppressed by the throttle would
    /// otherwise never render — the card would sit stale on the
    /// leading-edge state until the NEXT chunk lands outside the
    /// window. One deferred update per window re-reads the counters at
    /// expiry; `end` cancels it so a settled ✓/✗ card can't flip back
    /// to running.
    private func scheduleTrailingFlush(sessionId: String, in delay: TimeInterval) {
        guard pendingFlush[sessionId] == nil else { return }
        pendingFlush[sessionId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, delay)))
            guard let self, !Task.isCancelled else { return }
            self.pendingFlush[sessionId] = nil
            guard self.activities[sessionId] != nil else { return }
            self.pushRunningState(sessionId: sessionId)
        }
    }

    /// Push the counters' current "running" state to the activity.
    private func pushRunningState(sessionId: String) {
        guard let activity = activities[sessionId] else { return }
        let counter = counters[sessionId] ?? (0, "")
        lastLocalPush[sessionId] = Date()
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
        pendingFlush.removeValue(forKey: sessionId)?.cancel()
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
