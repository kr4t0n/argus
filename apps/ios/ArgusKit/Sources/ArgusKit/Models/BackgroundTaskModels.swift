import Foundation

// Mirrors packages/shared-types/src/api.ts (BackgroundTaskDTO) — the
// Progress extension's rows, produced by `argus-bg` wrapping long
// commands on the agent's machine.

/// One active-or-recently-ended background task in a project. Numeric
/// fields are Double because tqdm allows fractional totals/rates;
/// timestamps are ms-epoch.
public struct BackgroundTaskDTO: Codable, Equatable, Sendable, Identifiable {
    public var taskId: String
    public var machineId: String
    public var workingDir: String
    public var agentId: String
    public var label: String?
    public var cmd: [String]?
    /// Latest progress reading; absent until tqdm fires its first update.
    public var current: Double?
    public var total: Double?
    public var percent: Double?
    public var etaSeconds: Double?
    public var rate: Double?
    public var unit: String?
    public var desc: String?
    /// ms epoch when the task's start event was observed.
    public var startedAt: Double
    /// Latest event timestamp (start OR most recent progress OR end).
    public var ts: Double
    /// Set only after the task ends.
    public var endedAt: Double?
    public var exitCode: Int?
    /// 'done' | 'failed' (open string).
    public var status: String?

    public var id: String { taskId }

    public var isEnded: Bool { endedAt != nil }
}

/// `GET /machines/:id/background-tasks?workingDir=`.
public struct BackgroundTasksResponse: Decodable, Sendable {
    public var tasks: [BackgroundTaskDTO]
}
