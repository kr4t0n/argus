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
    public var agentCount: Int
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
/// pair the sidebar groups sessions under.
public struct ProjectDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var machineId: String
    public var workingDir: String
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
