import type { SessionDTO } from '@argus/shared-types';
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
 */
export function groupProjects(
  localProjects: Record<string, LocalProject>,
  localOrder: string[],
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

  return projects;
}
