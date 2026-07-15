import Foundation

// Mirrors packages/shared-types/src/api.ts (machines / agents / projects)
// and protocol.ts (AvailableAdapter).

public struct AvailableAdapter: Codable, Equatable, Sendable {
    public var type: AgentType
    public var binary: String
    /// Empty when `<binary> --version` couldn't be parsed.
    public var version: String
}

public struct MachineDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var hostname: String
    public var os: String
    public var arch: String
    public var sidecarVersion: String
    public var availableAdapters: [AvailableAdapter]
    public var status: MachineStatus
    public var lastSeenAt: String
    public var registeredAt: String
    public var archivedAt: String?
    public var iconKey: String?
}

public struct AgentDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var type: AgentType
    public var machineId: String
    public var machineName: String
    public var status: AgentStatus
    public var supportsTerminal: Bool
    public var version: String?
    public var workingDir: String?
    public var lastHeartbeatAt: String
    public var registeredAt: String
    public var archivedAt: String?
}

/// Server-side metadata for a "project" — the `(machineId, workingDir)`
/// pair the sidebar groups sessions under. Promoted to a first-class row
/// in Phase 1b (docs/plan-agent-to-runners.md): name/archive state now
/// roam across clients. Every promoted field is optional so the decode
/// stays tolerant of pre-promotion servers that omit them.
public struct ProjectDTO: Codable, Equatable, Sendable, Identifiable {
    /// Restore snapshot captured by the client-side archive cascade —
    /// only the ids the cascade flipped, so restore un-archives exactly
    /// those and preserves individual archives made earlier.
    public struct ArchiveSnapshot: Codable, Equatable, Sendable {
        public var archivedAgentIds: [String]
        public var archivedSessionIds: [String]
    }

    public var id: String
    public var machineId: String
    public var workingDir: String
    /// User-picked label; nil = client derives basename(workingDir).
    public var name: String?
    /// Default for agents auto-vivified under this project.
    public var supportsTerminal: Bool?
    /// ISO timestamp; nil = active.
    public var archivedAt: String?
    /// Nil when active or for legacy archives without a snapshot.
    public var archiveSnapshot: ArchiveSnapshot?
    public var iconKey: String?
}

public struct CreateAgentRequest: Encodable, Sendable {
    public var name: String
    public var type: AgentType
    public var workingDir: String?
    public var supportsTerminal: Bool?
    /// Adapter-specific options forwarded opaquely to the sidecar.
    public var adapter: [String: JSONValue]?

    public init(
        name: String,
        type: AgentType,
        workingDir: String? = nil,
        supportsTerminal: Bool? = nil,
        adapter: [String: JSONValue]? = nil
    ) {
        self.name = name
        self.type = type
        self.workingDir = workingDir
        self.supportsTerminal = supportsTerminal
        self.adapter = adapter
    }
}
