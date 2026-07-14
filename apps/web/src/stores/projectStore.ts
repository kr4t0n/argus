import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProjectDTO } from '@argus/shared-types';
import { api } from '../lib/api';

/**
 * Project rows, server-backed since Phase 1b of the agent→runner
 * refactor. A project is a named `(machineId, workingDir)` anchor
 * under which sessions are created. The store hydrates from
 * `GET /projects` at boot (and on WS reconnect), stays warm via
 * `project:upsert` events, and persists under `argus.projects` so
 * rows paint instantly on reload before the boot fetch reconciles.
 *
 * Mutations (`add`, `setArchived`) write through to the server first
 * and reconcile the map from the returned DTO — the archive *cascade*
 * (flipping sessions/agents) stays in the Sidebar via per-item REST;
 * only the outcome + restore snapshot live on the Project row.
 *
 * Rows without `serverId` are legacy client-only placeholders from
 * before the promotion; `migrateLocalProjectsToServer` pushes them up
 * once at boot, after which every row is server-backed.
 */
export interface LocalProject {
  id: string;
  /** Server Project row id. Undefined only for legacy un-migrated
   *  placeholders (pre-promotion localStorage rows). */
  serverId?: string;
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
  /** Replace/merge the map from a GET /projects response. Server rows
   *  win; legacy local-only placeholders (no serverId) not yet known
   *  to the server are preserved for the one-shot migration. Existing
   *  keys keep their order; new ones append. */
  hydrate(rows: ProjectDTO[]): void;
  /** Apply one server row — from a `project:upsert` WS event or a
   *  mutation response. */
  upsertFromDto(p: ProjectDTO): LocalProject;
  /** Create (or reclaim) a project server-side. Re-creating an
   *  archived pair un-archives it (restore-via-recreate). When
   *  `archivedAt` + snapshot are passed (Sidebar materializing an
   *  agent-derived row mid-archive), the archive is persisted in the
   *  same call chain. */
  add(
    input: Omit<
      LocalProject,
      | 'id'
      | 'serverId'
      | 'createdAt'
      | 'archivedAt'
      | 'archivedAgentIds'
      | 'archivedSessionIds'
      | 'iconKey'
    > & {
      archivedAt?: string | null;
      archivedAgentIds?: string[];
      archivedSessionIds?: string[];
    },
  ): Promise<LocalProject>;
  setArchived(key: string, archived: boolean, snapshot?: ArchiveSnapshot): Promise<void>;
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

function dtoToLocal(p: ProjectDTO, prev?: LocalProject): LocalProject {
  return {
    id: prev?.id ?? p.id,
    serverId: p.id,
    machineId: p.machineId,
    name: p.name ?? '',
    workingDir: p.workingDir,
    supportsTerminal: p.supportsTerminal,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    archivedAt: p.archivedAt,
    archivedAgentIds: p.archiveSnapshot?.archivedAgentIds,
    archivedSessionIds: p.archiveSnapshot?.archivedSessionIds,
    // Deprecated legacy glyph copy: preserved until the one-shot icon
    // migration strips it; the server value renders first regardless.
    iconKey: prev?.iconKey,
  };
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: {},
      order: [],
      serverIcons: {},
      hydrate(rows) {
        const prev = get().projects;
        const next: Record<string, LocalProject> = {};
        for (const row of rows) {
          const key = projectKey(row.machineId, row.workingDir);
          next[key] = dtoToLocal(row, prev[key]);
        }
        // Keep legacy un-migrated placeholders the server doesn't know
        // yet — migrateLocalProjectsToServer pushes them up right
        // after hydration, and dropping them here would lose the row
        // if that push fails.
        for (const [key, p] of Object.entries(prev)) {
          if (!next[key] && !p.serverId) next[key] = p;
        }
        const order = [
          ...get().order.filter((k) => next[k]),
          ...Object.keys(next).filter((k) => !get().order.includes(k)),
        ];
        set({ projects: next, order });
      },
      upsertFromDto(p) {
        const key = projectKey(p.machineId, p.workingDir);
        const prev = get().projects;
        const updated = dtoToLocal(p, prev[key]);
        set({
          projects: { ...prev, [key]: updated },
          order: get().order.includes(key) ? get().order : [...get().order, key],
        });
        return updated;
      },
      async add(input) {
        const dto = await api.createProject({
          machineId: input.machineId,
          workingDir: input.workingDir,
          name: input.name || undefined,
          supportsTerminal: input.supportsTerminal,
        });
        let final = dto;
        // Sidebar materializes agent-derived rows mid-archive by
        // creating them already-archived; persist that state in the
        // same chain. (Create always clears archive server-side, so
        // this ordering is safe for the restore-via-recreate flow.)
        if (input.archivedAt) {
          // Pass the snapshot only when the caller captured one — a
          // snapshot-less archive must stay snapshot-less server-side
          // so restore falls back to the broad path.
          final = await api.archiveProject(
            dto.id,
            input.archivedAgentIds !== undefined || input.archivedSessionIds !== undefined
              ? {
                  archivedAgentIds: input.archivedAgentIds ?? [],
                  archivedSessionIds: input.archivedSessionIds ?? [],
                }
              : undefined,
          );
        }
        return get().upsertFromDto(final);
      },
      async setArchived(key, archived, snapshot) {
        const existing = get().projects[key];
        if (!existing) return;
        // Legacy un-migrated placeholder: promote it on first touch so
        // the archive state has a server row to land on.
        let serverId = existing.serverId;
        if (!serverId) {
          const created = await api.createProject({
            machineId: existing.machineId,
            workingDir: existing.workingDir,
            name: existing.name || undefined,
            supportsTerminal: existing.supportsTerminal,
          });
          serverId = created.id;
        }
        const dto = archived
          ? await api.archiveProject(serverId, snapshot)
          : await api.unarchiveProject(serverId);
        get().upsertFromDto(dto);
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
