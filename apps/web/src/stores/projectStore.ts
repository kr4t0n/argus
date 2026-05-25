import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Client-only project placeholder. A project is a named `(machineId,
 * workingDir)` anchor under which agents are created. Today the
 * sidebar derives projects from agents' workingDirs; this store lets
 * the user create an *empty* project (no agents yet) from the machine
 * list and have it appear in the tree immediately. When agents
 * eventually land in the same `(machineId, workingDir)`, they merge
 * into the placeholder's row.
 *
 * Why client-only: no Machine→Project server entity yet. Persisted via
 * zustand under `argus.projects` so the placeholder survives reloads.
 * Promote to a Prisma table when the next step lands.
 */
export interface LocalProject {
  id: string;
  machineId: string;
  name: string;
  workingDir: string;
  supportsTerminal: boolean;
  createdAt: string;
  /**
   * ISO timestamp when the user archived the project; null = active.
   * Archiving a project cascades to its agents and sessions via the
   * sidebar action — the placeholder just owns the row's archived
   * identity so an agent-derived project can be restored as a unit.
   */
  archivedAt: string | null;
  /**
   * IDs the cascade actually flipped on archive (i.e. items that
   * were not already archived). Restore un-archives ONLY these,
   * preserving any individual archives the user made before the
   * cascade. Defined (possibly empty arrays) for snapshot-aware
   * archives; both fields undefined on legacy placeholders archived
   * before the snapshot existed — those fall back to broad restore
   * in the sidebar.
   */
  archivedAgentIds?: string[];
  archivedSessionIds?: string[];
  /**
   * User-picked single-character glyph (A-Z) shown in place of the
   * default Folder icon in the sidebar and rail. No default — until
   * the user explicitly picks, the row uses Folder so the picked
   * letter is a deliberate visual memory aid rather than an
   * auto-derived hint.
   */
  iconKey?: string;
}

export function projectKey(machineId: string, workingDir: string): string {
  return `${machineId}::${workingDir}`;
}

export interface ArchiveSnapshot {
  archivedAgentIds: string[];
  archivedSessionIds: string[];
}

interface ProjectState {
  projects: Record<string, LocalProject>;
  order: string[];
  add(
    input: Omit<
      LocalProject,
      'id' | 'createdAt' | 'archivedAt' | 'archivedAgentIds' | 'archivedSessionIds' | 'iconKey'
    > & {
      archivedAt?: string | null;
      archivedAgentIds?: string[];
      archivedSessionIds?: string[];
      /** A-Z letter, or `null` to clear back to the default folder. */
      iconKey?: string | null;
    },
  ): LocalProject;
  setArchived(key: string, archived: boolean, snapshot?: ArchiveSnapshot): void;
  remove(key: string): void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: {},
      order: [],
      add(input) {
        const key = projectKey(input.machineId, input.workingDir);
        const existing = get().projects[key];
        if (existing) {
          const merged: LocalProject = {
            ...existing,
            name: input.name || existing.name,
            supportsTerminal: input.supportsTerminal,
            // Only overwrite archive fields when the caller passes them
            // explicitly — `undefined` means "don't touch" so a re-submit
            // of the form doesn't accidentally unarchive a previously-
            // archived project or clobber its restore snapshot.
            ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
            ...(input.archivedAgentIds !== undefined
              ? { archivedAgentIds: input.archivedAgentIds }
              : {}),
            ...(input.archivedSessionIds !== undefined
              ? { archivedSessionIds: input.archivedSessionIds }
              : {}),
            // Same posture for iconKey — `null` from caller clears back
            // to default (Folder), `undefined` leaves existing alone.
            ...(input.iconKey !== undefined
              ? { iconKey: input.iconKey === null ? undefined : input.iconKey }
              : {}),
          };
          set({ projects: { ...get().projects, [key]: merged } });
          return merged;
        }
        const created: LocalProject = {
          id:
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `lp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          machineId: input.machineId,
          name: input.name,
          workingDir: input.workingDir,
          supportsTerminal: input.supportsTerminal,
          createdAt: new Date().toISOString(),
          archivedAt: input.archivedAt ?? null,
          archivedAgentIds: input.archivedAgentIds,
          archivedSessionIds: input.archivedSessionIds,
          iconKey: input.iconKey ?? undefined,
        };
        set({
          projects: { ...get().projects, [key]: created },
          order: [...get().order, key],
        });
        return created;
      },
      setArchived(key, archived, snapshot) {
        const projects = get().projects;
        const existing = projects[key];
        if (!existing) return;
        const updated: LocalProject = {
          ...existing,
          archivedAt: archived ? new Date().toISOString() : null,
          // Snapshot is meaningful only while archived. Clearing on
          // restore avoids the snapshot drifting forward if the user
          // re-archives later without a fresh capture.
          archivedAgentIds: archived ? snapshot?.archivedAgentIds : undefined,
          archivedSessionIds: archived ? snapshot?.archivedSessionIds : undefined,
        };
        set({ projects: { ...projects, [key]: updated } });
      },
      remove(key) {
        const projects = get().projects;
        if (!projects[key]) return;
        const next = { ...projects };
        delete next[key];
        set({
          projects: next,
          order: get().order.filter((k) => k !== key),
        });
      },
    }),
    { name: 'argus.projects' },
  ),
);
