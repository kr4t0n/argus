import Foundation

// Mirrors packages/shared-types/src/api.ts (machines / agents / projects)
// and protocol.ts (AvailableAdapter).

public struct AvailableAdapter: Codable, Equatable, Sendable {
    public let type: AgentType
    public let binary: String
    /// Empty when `<binary> --version` couldn't be parsed.
    public let version: String
}

public struct MachineDTO: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let hostname: String
    public let os: String
    public let arch: String
    public let sidecarVersion: String
    public let availableAdapters: [AvailableAdapter]
    public let status: MachineStatus
    public let lastSeenAt: String
    public let registeredAt: String
    public let archivedAt: String?
    public let agentCount: Int
    public let iconKey: String?
}

public struct AgentDTO: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let type: AgentType
    public let machineId: String
    public let machineName: String
    public let status: AgentStatus
    public let supportsTerminal: Bool
    public let version: String?
    public let workingDir: String?
    public let lastHeartbeatAt: String
    public let registeredAt: String
    public let archivedAt: String?
}

/// Server-side metadata for a "project" — the `(machineId, workingDir)`
/// pair the sidebar groups sessions under.
public struct ProjectDTO: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let machineId: String
    public let workingDir: String
    public let iconKey: String?
}

public struct CreateAgentRequest: Encodable, Sendable {
    public let name: String
    public let type: AgentType
    public let workingDir: String?
    public let supportsTerminal: Bool?
    /// Adapter-specific options forwarded opaquely to the sidecar.
    public let adapter: [String: JSONValue]?

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
