import type { AgentDTO } from '@argus/shared-types';
import type { LocalProject } from '../stores/projectStore';

/**
 * Synthetic key for agents whose `workingDir` is unset — they all
 * fall into a single per-machine bucket so they remain reachable in
 * surfaces that group by project. Module-private; callers identify
 * the bucket by `ProjectGroup.fullPath === null`.
 */
const NO_PROJECT_KEY = '__none__';

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
  agentIds: string[];
  /** Present when the row is backed by a user-created local project. */
  local?: LocalProject;
  /** True when the row's placeholder is archived. Cascades to agents +
   *  sessions on toggle (see ProjectRow.toggleProjectArchive). */
  archived: boolean;
}

/**
 * Bucket the global agent `order` into projects, where a project is a
 * unique `(workingDir, machineId)` pair — same path on different
 * machines lives on different physical filesystems, so they shouldn't
 * be merged. Agents with no `workingDir` fall into a synthetic
 * "no project" bucket per machine so they remain reachable.
 *
 * User-created `LocalProject` placeholders are merged in as a second
 * pass: a matching `(machineId, workingDir)` overlays the row's label
 * with the user-chosen name; an unmatched placeholder appears as an
 * empty project row so a fresh project shows up before its first agent
 * is created. Input order is preserved so adding/removing an agent
 * doesn't reshuffle unrelated rows.
 *
 * Both the main `Sidebar` and the collapsed `SidebarRail` consume
 * this so the two views agree on what counts as a project. Callers
 * pre-filter `order` / `localOrder` for the archived-visibility
 * posture they want.
 */
export function groupProjects(
  order: string[],
  agents: Record<string, AgentDTO>,
  localProjects: Record<string, LocalProject>,
  localOrder: string[],
): ProjectGroup[] {
  const projects: ProjectGroup[] = [];
  const projectIndex = new Map<string, number>();

  for (const id of order) {
    const a = agents[id];
    if (!a) continue;
    const wd = (a.workingDir ?? '').trim();
    const wdKey = wd || NO_PROJECT_KEY;
    const key = `${a.machineId}::${wdKey}`;
    let pIdx = projectIndex.get(key);
    if (pIdx === undefined) {
      pIdx = projects.length;
      projectIndex.set(key, pIdx);
      projects.push({
        key,
        label: wd ? basename(wd) : 'no project',
        fullPath: wd || null,
        machineId: a.machineId,
        agentIds: [],
        archived: false,
      });
    }
    projects[pIdx].agentIds.push(id);
  }

  for (const lkey of localOrder) {
    const lp = localProjects[lkey];
    if (!lp) continue;
    const key = `${lp.machineId}::${lp.workingDir}`;
    const pIdx = projectIndex.get(key);
    if (pIdx === undefined) {
      projectIndex.set(key, projects.length);
      projects.push({
        key,
        label: lp.name || basename(lp.workingDir),
        fullPath: lp.workingDir,
        machineId: lp.machineId,
        agentIds: [],
        local: lp,
        archived: !!lp.archivedAt,
      });
    } else {
      projects[pIdx].label = lp.name || projects[pIdx].label;
      projects[pIdx].local = lp;
      projects[pIdx].archived = !!lp.archivedAt;
    }
  }

  return projects;
}
