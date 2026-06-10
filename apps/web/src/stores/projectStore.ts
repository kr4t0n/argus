import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProjectDTO } from '@argus/shared-types';

/**
 * Client-only project placeholder. A project is a named `(machineId,
 * workingDir)` anchor under which agents are created. Today the
 * sidebar derives projects from agents' workingDirs; this store lets
 * the user create an *empty* project (no agents yet) from the machine
 * list and have it appear in the tree immediately. When agents
 * eventually land in the same `(machineId, workingDir)`, they merge
 * into the placeholder's row.
 *
 * Why client-only: no full Machine→Project server entity yet — only
 * per-project metadata that must roam across browsers has been
 * promoted (icons; see `serverIcons` + the server's Project row).
 * Placeholders themselves are persisted via zustand under
 * `argus.projects` so they survive reloads. Promote the rest to the
 * Prisma table when the next step lands.
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
   * @deprecated Legacy location of the user-picked glyph. Icons now
   * live server-side (Project row, synced via `serverIcons` below) so
   * they roam across browsers. Kept only as the source for the one-
   * shot boot migration (`migrateLocalProjectIconsToServer`) and as a
   * render fallback until it runs; never written anymore.
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
  /**
   * Server-synced project icons, keyed by `projectKey`. Source of
   * truth is the Project row server-side (PATCH /projects/icon);
   * hydrated from GET /projects at boot, kept warm by `project:upsert`
   * WS events, and persisted with the rest of the store so glyphs
   * render instantly on reload (the boot fetch then reconciles).
   */
  serverIcons: Record<string, string>;
  add(
    input: Omit<
      LocalProject,
      'id' | 'createdAt' | 'archivedAt' | 'archivedAgentIds' | 'archivedSessionIds' | 'iconKey'
    > & {
      archivedAt?: string | null;
      archivedAgentIds?: string[];
      archivedSessionIds?: string[];
    },
  ): LocalProject;
  setArchived(key: string, archived: boolean, snapshot?: ArchiveSnapshot): void;
  remove(key: string): void;
  /** Replace the whole icon map from a GET /projects response —
   *  replacement (not merge) is what propagates remote resets. */
  setServerIcons(rows: ProjectDTO[]): void;
  /** Apply one project's icon — from a `project:upsert` event or an
   *  optimistic local pick. `iconKey: null` removes the entry. */
  upsertServerIcon(p: Pick<ProjectDTO, 'machineId' | 'workingDir' | 'iconKey'>): void;
  /** Strip deprecated `LocalProject.iconKey` copies once they've been
   *  pushed server-side (or written through the new path). */
  clearLegacyIcons(keys: string[]): void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: {},
      order: [],
      serverIcons: {},
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
      setServerIcons(rows) {
        const serverIcons: Record<string, string> = {};
        for (const r of rows) {
          if (r.iconKey) serverIcons[projectKey(r.machineId, r.workingDir)] = r.iconKey;
        }
        set({ serverIcons });
      },
      upsertServerIcon(p) {
        const key = projectKey(p.machineId, p.workingDir);
        const serverIcons = { ...get().serverIcons };
        if (p.iconKey) serverIcons[key] = p.iconKey;
        else delete serverIcons[key];
        set({ serverIcons });
      },
      clearLegacyIcons(keys) {
        const projects = { ...get().projects };
        let touched = false;
        for (const key of keys) {
          const existing = projects[key];
          if (!existing || existing.iconKey === undefined) continue;
          projects[key] = { ...existing, iconKey: undefined };
          touched = true;
        }
        if (touched) set({ projects });
      },
    }),
    { name: 'argus.projects' },
  ),
);

/**
 * Resolved icon glyph for a project row: the server-synced value
 * first, the deprecated local-placeholder copy as a fallback until
 * the one-shot boot migration pushes it up. Undefined = no pick →
 * callers render the default folder.
 */
export function useProjectIconKey(key: string): string | undefined {
  return useProjectStore((s) => s.serverIcons[key] ?? s.projects[key]?.iconKey);
}
