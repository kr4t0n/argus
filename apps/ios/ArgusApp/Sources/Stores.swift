import Foundation
import Observation
import ArgusKit

/// Machines / agents / projects — the fleet the sidebar derives its
/// grouping from. Swift counterpart of the web's agent/machine stores.
@MainActor
@Observable
final class FleetStore {
    private(set) var agents: [String: AgentDTO] = [:]
    private(set) var machines: [String: MachineDTO] = [:]
    /// Keyed "machineId::workingDir", mirrors the web's project key.
    private(set) var projects: [String: ProjectDTO] = [:]

    func reset() {
        agents = [:]
        machines = [:]
        projects = [:]
    }

    func setAgents(_ list: [AgentDTO]) {
        agents = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    }

    func setMachines(_ list: [MachineDTO]) {
        machines = Dictionary(uniqueKeysWithValues: list.map { ($0.id, $0) })
    }

    func setProjects(_ list: [ProjectDTO]) {
        projects = Dictionary(
            list.map { (Self.projectKey(machineId: $0.machineId, workingDir: $0.workingDir), $0) },
            uniquingKeysWith: { _, new in new }
        )
    }

    func upsert(agent: AgentDTO) { agents[agent.id] = agent }
    func removeAgent(id: String) { agents[id] = nil }

    func applyAgentStatus(_ payload: IdStatusPayload) {
        guard var agent = agents[payload.id] else { return }
        agent.status = AgentStatus(rawValue: payload.status) ?? .unknown
        agents[payload.id] = agent
    }

    func upsert(machine: MachineDTO) { machines[machine.id] = machine }
    func removeMachine(id: String) { machines[id] = nil }

    func applyMachineStatus(_ payload: IdStatusPayload) {
        guard var machine = machines[payload.id] else { return }
        machine.status = MachineStatus(rawValue: payload.status) ?? .unknown
        machines[payload.id] = machine
    }

    func upsert(project: ProjectDTO) {
        projects[Self.projectKey(machineId: project.machineId, workingDir: project.workingDir)] = project
    }

    static func projectKey(machineId: String, workingDir: String) -> String {
        "\(machineId)::\(workingDir)"
    }
}

/// One sidebar group: the `(machineId, workingDir)` pair every session in
/// that directory shares (port of the web's `groupProjects`).
struct ProjectGroup: Identifiable {
    let id: String
    /// Last path component of the workingDir, or "no project".
    let title: String
    /// nil when the owning agent is unknown (can't anchor creation).
    let machineId: String?
    let workingDir: String?
    let machineName: String
    var sessions: [SessionDTO]
}

/// All sessions the user owns, with the monotonic-updatedAt guard the web
/// uses so a stale REST response can't resurrect a cleared unread dot.
@MainActor
@Observable
final class SessionListStore {
    private(set) var sessions: [String: SessionDTO] = [:]
    private(set) var loaded = false

    func reset() {
        sessions = [:]
        loaded = false
    }

    func setAll(_ list: [SessionDTO]) {
        // Merge row-by-row through the staleness guard: a WS status may
        // have landed while the GET was in flight.
        for session in list { upsert(session) }
        // Drop rows the server no longer returns (deleted/archived).
        let fresh = Set(list.map(\.id))
        for id in sessions.keys where !fresh.contains(id) {
            sessions[id] = nil
        }
        loaded = true
    }

    func upsert(_ session: SessionDTO) {
        if let existing = sessions[session.id], existing.updatedAt > session.updatedAt {
            return
        }
        sessions[session.id] = session
    }

    func applyStatus(_ event: SessionStatusEvent) {
        guard var session = sessions[event.id] else { return }
        guard event.updatedAt >= session.updatedAt else { return }
        session.status = event.status
        session.unread = event.unread
        session.updatedAt = event.updatedAt
        sessions[event.id] = session
    }

    /// Optimistically clear the dot the moment the user opens a session
    /// (the server confirms via a session:status echo).
    func markSeenLocally(id: String) {
        guard var session = sessions[id], session.unread else { return }
        session.unread = false
        sessions[id] = session
    }

    /// Group visible sessions by their agent's project, newest first —
    /// the iOS counterpart of the web sidebar's derivation.
    func projectGroups(fleet: FleetStore) -> [ProjectGroup] {
        var groups: [String: ProjectGroup] = [:]
        for session in sessions.values where session.archivedAt == nil {
            let agent = fleet.agents[session.agentId]
            let machineId = agent?.machineId ?? "unknown"
            let workingDir = agent?.workingDir ?? ""
            let key = FleetStore.projectKey(machineId: machineId, workingDir: workingDir)
            let title = workingDir.isEmpty
                ? "no project"
                : (workingDir as NSString).lastPathComponent
            let machineName = agent?.machineName
                ?? fleet.machines[machineId]?.name
                ?? ""
            groups[key, default: ProjectGroup(
                id: key,
                title: title,
                machineId: agent?.machineId,
                workingDir: agent?.workingDir,
                machineName: machineName,
                sessions: []
            )].sessions.append(session)
        }
        var result = Array(groups.values)
        for index in result.indices {
            result[index].sessions.sort { $0.updatedAt > $1.updatedAt }
        }
        // Most recently active project first.
        result.sort { ($0.sessions.first?.updatedAt ?? "") > ($1.sessions.first?.updatedAt ?? "") }
        return result
    }
}
