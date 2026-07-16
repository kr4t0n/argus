import type { MachineDTO, SessionDTO } from '@argus/shared-types';
import { useProjectStore, type LocalProject } from '../stores/projectStore';

/**
 * Everything the project-addressed read paths need (Phase 4 prep of
 * docs/plan-agent-to-runners.md): `projectId` drives the REST routes,
 * the (machineId, workingDir) pair names the WS room and the machine
 * for reachability. Resolved once per session view; components below
 * ContextPane/SessionPanel never touch agent identity for fs/git.
 */
export interface ProjectRef {
  projectId: string;
  machineId: string;
  workingDir: string;
}

/**
 * Resolve a session's ProjectRef. `session.projectId` is authoritative
 * (pinned at create); the (machineId, workingDir) pair comes from the
 * hydrated project rows via a serverId reverse lookup. Null for
 * workdir-less sessions (the "no project" bucket has no fs/git surface)
 * and during the boot race before the project rows hydrate. (Since the
 * Phase-5 sweep dropped Session.agentId there is no agent fallback.)
 */
export function resolveProjectRef(
  session: Pick<SessionDTO, 'projectId'> | null | undefined,
  projects: Record<string, LocalProject>,
): ProjectRef | null {
  if (!session?.projectId) return null;
  for (const p of Object.values(projects)) {
    if (p.serverId === session.projectId) {
      return { projectId: session.projectId, machineId: p.machineId, workingDir: p.workingDir };
    }
  }
  return null;
}

/** Hook flavor of resolveProjectRef, subscribed to the project store. */
export function useProjectRef(
  session: Pick<SessionDTO, 'projectId'> | null | undefined,
): ProjectRef | null {
  const projects = useProjectStore((s) => s.projects);
  return resolveProjectRef(session, projects);
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

export interface ProjectGroup {
  key: string;
  label: string;
  fullPath: string | null;
  machineId: string;
  /** Present when the row is backed by a user-created local project. */
  local?: LocalProject;
  /** True when the row's placeholder is archived. Cascades to its
   *  sessions on toggle (see ProjectRow.toggleProjectArchive). */
  archived: boolean;
}

/**
 * Build the sidebar's project rows from the user-created `LocalProject`
 * placeholders / server-backed project rows. A project is a unique
 * `(machineId, workingDir)` pair — the same path on different machines
 * lives on different physical filesystems, so they aren't merged.
 *
 * (Pre-Phase-5 this also derived rows from agent `workingDir`s; agents
 * are retired, so `localProjects` is the sole source now.) Both the main
 * `Sidebar` and the collapsed `SidebarRail` consume this so the two views
 * agree on what counts as a project. Callers pre-filter `localOrder` for
 * the archived-visibility posture they want.
 *
 * `localOrder` now only selects *which* projects appear (and the
 * archived-visibility filter callers apply to it); the display order is
 * the machine→project sort of `sortProjectGroups`, so both views group
 * projects under their host the way the iOS client does.
 */
export function groupProjects(
  localProjects: Record<string, LocalProject>,
  localOrder: string[],
  machines: Record<string, MachineDTO>,
): ProjectGroup[] {
  const projects: ProjectGroup[] = [];

  for (const lkey of localOrder) {
    const lp = localProjects[lkey];
    if (!lp) continue;
    projects.push({
      key: `${lp.machineId}::${lp.workingDir}`,
      label: lp.name || basename(lp.workingDir),
      fullPath: lp.workingDir,
      machineId: lp.machineId,
      local: lp,
      archived: !!lp.archivedAt,
    });
  }

  return sortProjectGroups(projects, machines);
}

/**
 * Order the sidebar's project rows by their host, ported verbatim from
 * the iOS client's `projectGroups(fleet:)` sort — the machine/project
 * ordering the web lost in the agent→runner refactor (the old tree
 * piggybacked on the retired agent arrival order). Precedence, top to
 * bottom:
 *   1. projects on ONLINE machines before those on offline ones,
 *   2. then machine name (case-insensitive),
 *   3. the per-machine "no project" bucket (`fullPath == null`) sinks
 *      below that machine's named projects,
 *   4. then project label (case-insensitive),
 *   5. group key as the deterministic tiebreaker.
 * Sessions *within* a project stay newest-first — that ordering is the
 * callers' responsibility and is untouched here. Missing machine rows
 * (pre-hydration) sort as offline with an empty name, matching iOS.
 */
export function sortProjectGroups(
  groups: ProjectGroup[],
  machines: Record<string, MachineDTO>,
): ProjectGroup[] {
  const onlineRank = (machineId: string) =>
    machines[machineId]?.status === 'online' ? 0 : 1;
  const machineName = (machineId: string) => machines[machineId]?.name ?? '';
  // Case-insensitive but accent-sensitive, matching iOS's
  // `localizedCaseInsensitiveCompare`.
  const ci = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: 'accent' });

  return [...groups].sort((a, b) => {
    const online = onlineRank(a.machineId) - onlineRank(b.machineId);
    if (online !== 0) return online;
    const byMachine = ci(machineName(a.machineId), machineName(b.machineId));
    if (byMachine !== 0) return byMachine;
    const noProject = (a.fullPath == null ? 1 : 0) - (b.fullPath == null ? 1 : 0);
    if (noProject !== 0) return noProject;
    const byLabel = ci(a.label, b.label);
    if (byLabel !== 0) return byLabel;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}
