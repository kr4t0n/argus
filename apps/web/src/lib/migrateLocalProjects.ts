import { api } from './api';
import { useMachineStore } from '../stores/machineStore';
import { useProjectStore } from '../stores/projectStore';

/**
 * One-shot migration companion to `migrateProjectIcons.ts`: project
 * *placeholders* (name, archive state + restore snapshot, terminal
 * default) used to live only in `argus.projects` localStorage; they
 * now live on the server's Project row (Phase 1b of
 * docs/plan-agent-to-runners.md).
 *
 * On first boot after the upgrade, every persisted row without a
 * `serverId` is pushed up: create (upsert by (machineId, workingDir),
 * so a row another browser promoted first just merges), then archive
 * with the snapshot if the local copy was archived. Skips rows whose
 * machine is gone (the POST would 404). Re-running is harmless — the
 * hydrated rows all carry `serverId`, so the loop finds nothing.
 *
 * Call after BOTH the machine roster and `hydrate(GET /projects)`
 * have landed, so a state change made on another browser wins over
 * the stale local copy (hydrate only preserves local rows the server
 * doesn't know at all).
 */
export async function migrateLocalProjectsToServer(): Promise<void> {
  const { projects } = useProjectStore.getState();
  const machines = useMachineStore.getState().machines;

  const tasks: Promise<unknown>[] = [];
  for (const p of Object.values(projects)) {
    if (p.serverId) continue;
    if (!machines[p.machineId]) continue;
    tasks.push(
      (async () => {
        const dto = await api.createProject({
          machineId: p.machineId,
          workingDir: p.workingDir,
          name: p.name || undefined,
          supportsTerminal: p.supportsTerminal,
        });
        let final = dto;
        if (p.archivedAt) {
          final = await api.archiveProject(
            dto.id,
            p.archivedAgentIds !== undefined || p.archivedSessionIds !== undefined
              ? {
                  archivedAgentIds: p.archivedAgentIds ?? [],
                  archivedSessionIds: p.archivedSessionIds ?? [],
                }
              : undefined,
          );
        }
        useProjectStore.getState().upsertFromDto(final);
      })().catch(() => {
        // Non-fatal: the row stays local-only (serverId undefined) and
        // the next boot retries; first user mutation also promotes it
        // (see projectStore.setArchived).
      }),
    );
  }
  if (tasks.length > 0) await Promise.allSettled(tasks);
}
