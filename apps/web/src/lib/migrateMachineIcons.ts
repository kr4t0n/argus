import { api } from './api';
import { useMachineStore } from '../stores/machineStore';

/**
 * One-shot migration: machine icons used to live in
 * `argus.ui.machineIcons` (localStorage), which meant they didn't
 * roam between devices. They now live on the Machine row server-side.
 *
 * On first boot after the upgrade we look for any leftover entries
 * in localStorage and PUSH them to the server — but only for
 * machines that don't already have an iconKey set. That way an
 * operator who happened to set the same machine's icon on a
 * teammate's device first wins (the migration won't clobber a
 * server-side value with a stale local one), and re-running the
 * migration is idempotent.
 *
 * Safe to call multiple times: after a successful pass we strip
 * `machineIcons` out of `argus.ui` so subsequent calls find
 * nothing to do.
 */
export async function migrateLocalMachineIconsToServer(): Promise<void> {
  const local = readLocalIcons();
  if (!local || Object.keys(local).length === 0) return;

  const machines = useMachineStore.getState().machines;
  // Only migrate icons for machines we know about AND that don't
  // already have a server-side icon. We deliberately don't error
  // out on unknown machineIds — they were probably destroyed and
  // would 404, and we don't want a single bad row to block the rest.
  const tasks: Promise<unknown>[] = [];
  for (const [machineId, iconKey] of Object.entries(local)) {
    const m = machines[machineId];
    if (!m) continue;
    if (m.iconKey) continue;
    if (typeof iconKey !== 'string' || !iconKey) continue;
    tasks.push(
      api.setMachineIcon(machineId, iconKey).catch(() => {
        // Non-fatal: the next time the user picks an icon they'll
        // still get the new server-backed flow. We don't retry on
        // boot beyond this single attempt to keep migration cheap.
      }),
    );
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }

  // Strip the now-obsolete field from localStorage regardless of
  // per-row success: leaving stale entries means we'd re-attempt
  // on every reload, and the picker has been wired to the server
  // anyway so anything left here would just be dead weight.
  clearLocalIcons();
}

function readLocalIcons(): Record<string, string> | null {
  try {
    const raw = window.localStorage.getItem('argus.ui');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { machineIcons?: unknown } };
    const icons = parsed?.state?.machineIcons;
    if (!icons || typeof icons !== 'object') return null;
    return icons as Record<string, string>;
  } catch {
    return null;
  }
}

function clearLocalIcons(): void {
  try {
    const raw = window.localStorage.getItem('argus.ui');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (!parsed?.state || !('machineIcons' in parsed.state)) return;
    delete parsed.state.machineIcons;
    window.localStorage.setItem('argus.ui', JSON.stringify(parsed));
  } catch {
    // If we can't tidy up localStorage the migration still won't
    // re-run destructively (it only ever pushes when the server-side
    // value is empty), so swallow the error.
  }
}
