import { create } from 'zustand';
import type { RemovedProjectDTO } from '@argus/shared-types';
import { api } from '../lib/api';
import { useProjectStore } from './projectStore';
import { useSessionStore } from './sessionStore';

/**
 * Label-only context for sessions whose machine has been soft-deleted.
 *
 * Deleting a machine is non-destructive: the tombstone hides it from
 * every active surface, but the sessions underneath keep their full
 * transcripts (every read on that path is user-scoped and joins no
 * machine). They stay reachable through search — which is the whole
 * point of the delete being a tombstone — but `projectStore` drops the
 * project rows, so nothing could say *where* those sessions ran.
 * `GET /projects/removed` fills exactly that gap and nothing else.
 *
 * This is deliberately NOT `projectStore`. Rows here must never reach
 * the sidebar or any action path: fs, git and terminal all 404 on a
 * deleted machine's project, and dispatch is refused outright
 * (`resolveRouting` returns null for a tombstone). Keeping tombstoned
 * rows in their own store means a component has to opt in by name to
 * get one, instead of being handed a live-looking project by accident.
 *
 * Not persisted: it's derived server state, it changes only when a
 * machine is deleted, and a stale copy in localStorage would outlive
 * its usefulness. The fetch is conditional (see `ensureRemovedContext`)
 * so the common fleet — no deleted machines — never pays for it.
 */
interface RemovedContextState {
  /** Keyed by Project row id, the join key against `SessionDTO.projectId`. */
  byProjectId: Record<string, RemovedProjectDTO>;
  /** Replace the map from the server. Concurrent calls share one request. */
  refresh(): Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useRemovedContextStore = create<RemovedContextState>()((set) => ({
  byProjectId: {},
  refresh() {
    if (inFlight) return inFlight;
    inFlight = api
      .listRemovedProjects()
      .then((rows) => {
        const byProjectId: Record<string, RemovedProjectDTO> = {};
        for (const row of rows) byProjectId[row.id] = row;
        set({ byProjectId });
      })
      .catch(() => {
        // Non-fatal: labels fall back to "removed machine" without it.
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },
}));

/**
 * Fetch the context only if something actually needs it — i.e. the
 * session list holds a session whose `projectId` resolves to no known
 * project. That's precisely the deleted-machine case: `GET /projects`
 * filters tombstoned machines out, so their projects are absent while
 * their sessions are still listed (`GET /sessions` has no machine
 * join, by design — it's what keeps the history reachable).
 *
 * Call after BOTH the session list and the project hydrate have
 * landed, or the boot race reads as "everything is unresolved" and
 * fetches for a fleet with no deleted machines at all.
 */
export function ensureRemovedContext(): void {
  const { projects } = useProjectStore.getState();
  const { sessions } = useSessionStore.getState();
  const { byProjectId } = useRemovedContextStore.getState();

  const known = new Set<string>();
  for (const p of Object.values(projects)) if (p.serverId) known.add(p.serverId);

  for (const s of Object.values(sessions)) {
    if (!s.projectId) continue; // workdir-less sessions anchor to nothing
    if (known.has(s.projectId)) continue;
    if (byProjectId[s.projectId]) continue; // already covered
    void useRemovedContextStore.getState().refresh();
    return;
  }
}
