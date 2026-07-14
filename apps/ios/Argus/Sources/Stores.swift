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

    /// Resolve a session's ProjectRef (port of the web's
    /// `resolveProjectRef`). `session.projectId` is authoritative —
    /// pinned at create; the `(machineId, workingDir)` pair comes from
    /// the agent row when loaded (same pair by construction), else from
    /// the hydrated Project rows via an id reverse lookup. Nil for
    /// workdir-less sessions (the "no project" bucket has no fs/git
    /// surface) and during the boot race before either store has the row.
    func projectRef(for session: SessionDTO?) -> ProjectRef? {
        guard let session, let projectId = session.projectId else { return nil }
        if let agent = session.agentId.flatMap({ agents[$0] }),
           let workingDir = agent.workingDir, !workingDir.isEmpty {
            return ProjectRef(
                projectId: projectId,
                machineId: agent.machineId,
                workingDir: workingDir
            )
        }
        for project in projects.values where project.id == projectId {
            return ProjectRef(
                projectId: projectId,
                machineId: project.machineId,
                workingDir: project.workingDir
            )
        }
        return nil
    }
}

/// Everything the project-addressed read paths need (Phase 4 prep of
/// docs/plan-agent-to-runners.md): `projectId` drives the REST routes,
/// the `(machineId, workingDir)` pair names the WS room and the machine
/// for reachability. Resolved via `FleetStore.projectRef(for:)`; panes
/// below the inspector never touch agent identity for fs/git.
struct ProjectRef: Equatable {
    let projectId: String
    let machineId: String
    let workingDir: String
}

/// One sidebar group: the `(machineId, workingDir)` pair every session in
/// that directory shares (port of the web's `groupProjects`).
struct ProjectGroup: Identifiable {
    let id: String
    /// The user-picked Project.name, else the workingDir's basename, or
    /// "no project".
    let title: String
    /// nil ONLY for the orphan bucket (can't anchor creation there);
    /// groups resolved via a Project row or an agent join always carry it
    /// so the header's "+" stays enabled.
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

    /// Group visible sessions into projects. Since the runner refactor
    /// the grouping key is `session.projectId` resolved through the
    /// server's Project rows; the agent join remains as a fallback for
    /// pre-backfill sessions (nil projectId) and for rows the project
    /// list hasn't hydrated yet. Sessions with neither anchor land in a
    /// trailing "__orphan__" bucket so they stay reachable. A group
    /// resolved through either path carries a non-nil machineId, which
    /// keeps the header's "+" (new session) enabled.
    ///
    /// Ordering rule (deliberate — replaces the old piggyback on the
    /// agent sort, which died with per-agent status):
    ///   1. groups on ONLINE machines first,
    ///   2. then machine name (case-insensitive),
    ///   3. then project display name (Project.name overlay or
    ///      basename(workingDir)); the per-machine "no project" bucket
    ///      sinks below named projects of the same machine,
    ///   4. group key as the deterministic tiebreaker.
    /// Sessions within a project are newest-first.
    func projectGroups(fleet: FleetStore) -> [ProjectGroup] {
        // Reverse index: Project.id → row (fleet.projects is keyed by
        // the machineId::workingDir pair).
        var projectsById: [String: ProjectDTO] = [:]
        for project in fleet.projects.values {
            projectsById[project.id] = project
        }

        var groups: [String: ProjectGroup] = [:]
        var orphans: [SessionDTO] = []

        for session in sessions.values {
            // Resolve the (machineId, workingDir) anchor: projectId →
            // Project row is authoritative, agent join is the fallback.
            var machineId: String?
            var workingDir: String?
            var agentMachineName: String?
            if let projectId = session.projectId, let project = projectsById[projectId] {
                machineId = project.machineId
                workingDir = project.workingDir
            } else if let agent = session.agentId.flatMap({ fleet.agents[$0] }) {
                machineId = agent.machineId
                workingDir = agent.workingDir ?? ""
                agentMachineName = agent.machineName
            }
            guard let machineId else {
                orphans.append(session)
                continue
            }

            let wd = workingDir ?? ""
            let key = FleetStore.projectKey(machineId: machineId, workingDir: wd)
            if groups[key] == nil {
                // The pair-keyed row (when hydrated) overlays the
                // user-picked name regardless of which path anchored us.
                let row = fleet.projects[key]
                let fallbackTitle = wd.isEmpty
                    ? "no project"
                    : (wd as NSString).lastPathComponent
                let name = row?.name?.isEmpty == false ? row?.name : nil
                groups[key] = ProjectGroup(
                    id: key,
                    title: name ?? fallbackTitle,
                    machineId: machineId,
                    workingDir: wd.isEmpty ? nil : wd,
                    machineName: fleet.machines[machineId]?.name ?? agentMachineName ?? "",
                    sessions: [],
                    archivedSessions: []
                )
            }
            if session.archivedAt == nil {
                groups[key]?.sessions.append(session)
            } else {
                groups[key]?.archivedSessions.append(session)
            }
        }

        // Sessions with no projectId AND no live agent row — keep them
        // reachable in a trailing "no project" bucket.
        if !orphans.isEmpty {
            groups["__orphan__"] = ProjectGroup(
                id: "__orphan__", title: "no project", machineId: nil, workingDir: nil,
                machineName: "",
                sessions: orphans.filter { $0.archivedAt == nil },
                archivedSessions: orphans.filter { $0.archivedAt != nil }
            )
        }

        var result = groups.values.map { group -> ProjectGroup in
            var group = group
            group.sessions.sort { $0.updatedAt > $1.updatedAt }
            group.archivedSessions.sort { $0.updatedAt > $1.updatedAt }
            return group
        }
        result.sort { a, b in
            // Orphan bucket last, always.
            if (a.machineId == nil) != (b.machineId == nil) { return b.machineId == nil }
            let aOnline = a.machineId.flatMap { fleet.machines[$0]?.status } == .online ? 0 : 1
            let bOnline = b.machineId.flatMap { fleet.machines[$0]?.status } == .online ? 0 : 1
            if aOnline != bOnline { return aOnline < bOnline }
            let machine = a.machineName.localizedCaseInsensitiveCompare(b.machineName)
            if machine != .orderedSame { return machine == .orderedAscending }
            // The per-machine "no project" bucket sinks within its machine.
            if (a.workingDir == nil) != (b.workingDir == nil) { return b.workingDir == nil }
            let title = a.title.localizedCaseInsensitiveCompare(b.title)
            if title != .orderedSame { return title == .orderedAscending }
            return a.id < b.id
        }
        return result
    }
}
