import { api } from './api';
import { useMachineStore } from '../stores/machineStore';
import { useProjectStore } from '../stores/projectStore';

/**
 * One-shot migration: project icons used to live on the client-local
 * placeholder (`LocalProject.iconKey` inside `argus.projects`
 * localStorage), which meant they didn't roam between browsers. They
 * now live on the server's Project row, mirroring how machine icons
 * moved in `migrateMachineIcons.ts`.
 *
 * On first boot after the upgrade we PUSH any leftover local picks to
 * the server — but only for projects whose machine still exists (a
 * destroyed host would just 404) and that don't already have a
 * server-side icon, so a pick made on another browser first wins and
 * re-running is idempotent.
 *
 * Afterwards we strip every legacy local copy regardless of per-row
 * success. Leaving them would re-attempt on each reload, and — worse —
 * a stale local letter would shadow a deliberate "reset to folder"
 * made from another browser (the renderer falls back to the local copy
 * only while it exists).
 *
 * Call after BOTH the machine roster and the server icon map have
 * hydrated.
 */
export async function migrateLocalProjectIconsToServer(): Promise<void> {
  const { projects, serverIcons, clearLegacyIcons } = useProjectStore.getState();
  const machines = useMachineStore.getState().machines;

  const legacyKeys: string[] = [];
  const tasks: Promise<unknown>[] = [];
  for (const [key, p] of Object.entries(projects)) {
    if (!p.iconKey) continue;
    legacyKeys.push(key);
    if (!machines[p.machineId]) continue;
    if (serverIcons[key]) continue;
    tasks.push(
      api
        .setProjectIcon(p.machineId, p.workingDir, p.iconKey)
        .then((dto) => useProjectStore.getState().upsertServerIcon(dto))
        .catch(() => {
          // Non-fatal: the next pick goes through the server-backed
          // flow anyway; no retry beyond this single attempt.
        }),
    );
  }
  if (tasks.length > 0) await Promise.allSettled(tasks);
  if (legacyKeys.length > 0) clearLegacyIcons(legacyKeys);
}
