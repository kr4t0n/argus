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
    /// Active (non-archived) sessions, newest-first.
    var sessions: [SessionDTO]
    /// Archived sessions, newest-first — rendered only when the
    /// project's eye toggle is on (web's showArchived), but always
    /// carried so the header can offer the toggle. A project whose
    /// sessions are ALL archived still gets its header row; otherwise
    /// the archive would be unreachable.
    var archivedSessions: [SessionDTO]
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
        // Drop rows the server no longer returns (hard-deleted; archived
        // rows ARE returned — lists load with includeArchived).
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

    /// Group visible sessions into projects, matching the web sidebar's
    /// ordering exactly: projects follow the global AGENT sort order
    /// (`groupProjects` over `agentStore.order`), so each project sits at
    /// its first agent's position — reachable machines first, grouped by
    /// machine name, then agent type/name. Sessions within a project are
    /// newest-first. (NOT recency-ordered — that was the divergence.)
    func projectGroups(fleet: FleetStore) -> [ProjectGroup] {
        var sessionsByAgent: [String: [SessionDTO]] = [:]
        for session in sessions.values {
            sessionsByAgent[session.agentId, default: []].append(session)
        }

        // Agents in the web's global sort order (agentStore.sortOrder).
        // fleet.agents includes archived agents (fetched with
        // includeArchived) so their sessions group correctly; the
        // comparator sinks them to the end.
        let sortedAgents = fleet.agents.values.sorted(by: Self.agentSortsBefore)

        var order: [String] = []
        var groups: [String: ProjectGroup] = [:]
        for agent in sortedAgents {
            guard let agentSessions = sessionsByAgent[agent.id], !agentSessions.isEmpty else {
                continue
            }
            let workingDir = agent.workingDir ?? ""
            let key = FleetStore.projectKey(machineId: agent.machineId, workingDir: workingDir)
            if groups[key] == nil {
                order.append(key)
                groups[key] = ProjectGroup(
                    id: key,
                    title: workingDir.isEmpty ? "no project" : (workingDir as NSString).lastPathComponent,
                    machineId: agent.machineId,
                    workingDir: agent.workingDir,
                    machineName: agent.machineName,
                    sessions: [],
                    archivedSessions: []
                )
            }
            groups[key]?.sessions.append(contentsOf: agentSessions.filter { $0.archivedAt == nil })
            groups[key]?.archivedSessions.append(contentsOf: agentSessions.filter { $0.archivedAt != nil })
        }

        // Sessions whose agent is gone from the fleet — keep them
        // reachable in a trailing "no project" bucket.
        let known = Set(fleet.agents.keys)
        let orphans = sessions.values.filter { !known.contains($0.agentId) }
        if !orphans.isEmpty {
            let key = "__orphan__"
            order.append(key)
            groups[key] = ProjectGroup(
                id: key, title: "no project", machineId: nil, workingDir: nil,
                machineName: "",
                sessions: orphans.filter { $0.archivedAt == nil },
                archivedSessions: orphans.filter { $0.archivedAt != nil }
            )
        }

        return order.compactMap { key -> ProjectGroup? in
            guard var group = groups[key] else { return nil }
            group.sessions.sort { $0.updatedAt > $1.updatedAt }
            group.archivedSessions.sort { $0.updatedAt > $1.updatedAt }
            return group
        }
    }

    /// Agent comparator ported from the web's `agentStore.sortOrder`:
    /// archived sink, then offline sink, then machineName, type, name.
    static func agentSortsBefore(_ a: AgentDTO, _ b: AgentDTO) -> Bool {
        let aArchived = a.archivedAt != nil ? 1 : 0
        let bArchived = b.archivedAt != nil ? 1 : 0
        if aArchived != bArchived { return aArchived < bArchived }
        // online/busy/error all count as reachable (0); offline sinks (1).
        let aOffline = a.status == .offline ? 1 : 0
        let bOffline = b.status == .offline ? 1 : 0
        if aOffline != bOffline { return aOffline < bOffline }
        let machine = a.machineName.localizedCompare(b.machineName)
        if machine != .orderedSame { return machine == .orderedAscending }
        let type = a.type.localizedCompare(b.type)
        if type != .orderedSame { return type == .orderedAscending }
        return a.name.localizedCompare(b.name) == .orderedAscending
    }
}
