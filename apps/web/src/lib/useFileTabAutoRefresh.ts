import { useEffect } from 'react';
import { joinProject, leaveProject, subscribeHandler } from './ws';
import { useFileTabsStore } from '../stores/fileTabsStore';
import type { ProjectRef } from './projects';

/**
 * Keeps open file tabs in sync with what the CLIs are writing on disk.
 *
 * The signal already exists end to end — the sidecar's fsWatcher emits a
 * debounced dir-level nudge for content edits (verified: in-place writes
 * AND atomic write-temp-then-rename both fire), the server fans it out to
 * the project room, and FileTree has consumed it since it shipped. All
 * this hook adds is: translate the nudge into a per-tab staleness bump.
 *
 * Deliberately lives in SessionPanel rather than FileViewer, because only
 * the FOCUSED tab's viewer is mounted. A subscription inside the viewer
 * could never mark a background tab stale, so switching to one would show
 * content from whenever you last looked at it.
 *
 * Two guards keep the resulting `fs-read` traffic honest — it rides the
 * byte-capped `lifecycle` Redis stream alongside machine heartbeats, at up
 * to 1 MB a response:
 *   - a trailing debounce on top of the sidecar's own 250 ms, so a long
 *     edit loop collapses instead of issuing a read per window;
 *   - nothing is invalidated while the browser tab is hidden; pending
 *     directories are held and flushed on the way back to visible, so a
 *     backgrounded dashboard costs nothing at all.
 * The bigger limiter is structural: a bump only turns into a request for
 * the one tab that's currently focused.
 */

/** Trailing window for coalescing nudges. Comfortably above the
 *  sidecar's 250 ms fsWatcher debounce so a steady stream of writes to
 *  one directory settles into a single refetch rather than tracking the
 *  agent's edit rate. */
const INVALIDATE_DEBOUNCE_MS = 400;

export function useFileTabAutoRefresh(project: ProjectRef | null): void {
  const invalidateDir = useFileTabsStore((s) => s.invalidateDir);
  const projectId = project?.projectId ?? null;
  const machineId = project?.machineId ?? null;
  const workingDir = project?.workingDir ?? null;

  useEffect(() => {
    if (!projectId || !machineId || !workingDir) return;
    joinProject(machineId, workingDir);

    // Dirs nudged since the last flush. A Set because one edit burst
    // routinely touches the same directory many times.
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      timer = undefined;
      // Hidden tab: keep the dirs pending rather than dropping them, so
      // coming back refreshes once instead of showing stale content.
      if (document.hidden) return;
      for (const dir of pending) invalidateDir(projectId, dir);
      pending.clear();
    };

    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
    };

    const onVisibility = () => {
      if (!document.hidden && pending.size > 0) flush();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const unsubscribe = subscribeHandler({
      onFSChanged: (ev) => {
        if (!ev.workingDir || ev.machineId !== machineId || ev.workingDir !== workingDir) return;
        pending.add(ev.path);
        schedule();
      },
    });

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer !== undefined) clearTimeout(timer);
      leaveProject(machineId, workingDir);
    };
  }, [projectId, machineId, workingDir, invalidateDir]);
}
