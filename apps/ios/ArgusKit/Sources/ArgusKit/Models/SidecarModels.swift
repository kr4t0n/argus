import Foundation

// Mirrors packages/shared-types/src/api.ts (sidecar version + remote
// update section).

/// `GET /machines/:id/sidecar/version`. `latest` comes from a ~30-min
/// server-side cache of the GitHub release tag.
public struct SidecarVersionInfo: Codable, Equatable, Sendable {
    public var current: String
    public var latest: String?
    public var latestCheckedAt: String?
    public var updateAvailable: Bool
}

/// 202 body for `POST /machines/:id/sidecar/update`. The loop closes
/// when the machine re-registers with the new version (machine:upsert).
public struct SidecarUpdateAccepted: Codable, Equatable, Sendable {
    public var requestId: String
    public var machineId: String
    public var fromVersion: String
}

/// One row in a bulk-update plan; `status` is an open string
/// ('queued' | 'in-progress' | 'completed' | 'failed' |
/// 'skipped-offline' | 'skipped-already-current').
public struct SidecarUpdatePlanEntry: Codable, Equatable, Sendable {
    public var machineId: String
    public var machineName: String
    public var fromVersion: String
    public var status: String
    public var toVersion: String?
    public var error: String?
}

/// 202 body for `POST /machines/sidecar/update-all`.
public struct SidecarUpdateBatchAccepted: Codable, Equatable, Sendable {
    public var batchId: String
    public var plan: [SidecarUpdatePlanEntry]
}
