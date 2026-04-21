import { create } from 'zustand';
import type { SidecarUpdatePlanEntry, SidecarVersionInfo } from '@argus/shared-types';

/**
 * Per-machine update progress shown in the toast stack. We key by
 * machineId rather than requestId because the dashboard surfaces one
 * "this machine is updating" line per host — even if a buggy operator
 * managed to fire two requests in quick succession (the server's
 * single-flight guard would reject the second), only the first one is
 * meaningful to render.
 *
 * The phase progression is: pending (button click → server hasn't
 * confirmed yet) → started (sidecar acknowledged) → downloaded
 * (binary swapped, restarting) → completed (new sidecar re-registered)
 * | failed (any step). 'manual' is the same as 'completed' but
 * surfaces a different message ("restart needed").
 */
export type UpdatePhase =
  | 'pending'
  | 'started'
  | 'downloaded'
  | 'completed'
  | 'failed';

export interface MachineUpdate {
  machineId: string;
  machineName: string;
  fromVersion: string;
  toVersion?: string;
  phase: UpdatePhase;
  restartMode?: 'self' | 'supervisor' | 'manual';
  error?: string;
  // When the user dismisses a finished toast we stop rendering it
  // but keep the entry around for a beat so a stray late event
  // doesn't resurrect it.
  dismissed: boolean;
  // Wall clock for sorting + auto-dismiss.
  startedAt: number;
}

export interface BatchProgress {
  batchId: string;
  plan: SidecarUpdatePlanEntry[];
  startedAt: number;
  dismissed: boolean;
}

interface State {
  /** Per-machine in-flight + recent updates, keyed by machineId. */
  updates: Record<string, MachineUpdate>;
  /** Cached version info for the per-row "update available" badge. */
  versions: Record<string, SidecarVersionInfo>;
  /** Currently visible bulk-update progress strip, if any. */
  batch: BatchProgress | null;

  // ─── per-machine actions ───
  begin: (machineId: string, machineName: string, fromVersion: string) => void;
  setStarted: (machineId: string, fromVersion: string) => void;
  setDownloaded: (
    machineId: string,
    fromVersion: string,
    toVersion: string,
    restartMode: 'self' | 'supervisor' | 'manual',
  ) => void;
  setCompleted: (machineId: string, fromVersion: string, toVersion: string) => void;
  setFailed: (machineId: string, fromVersion: string, reason: string) => void;
  dismiss: (machineId: string) => void;

  // ─── version cache ───
  setVersionInfo: (machineId: string, info: SidecarVersionInfo) => void;
  // Convenience for components that only care about the badge bool.
  isUpdateAvailable: (machineId: string) => boolean;

  // ─── bulk ───
  setBatch: (batch: BatchProgress) => void;
  updateBatch: (batchId: string, plan: SidecarUpdatePlanEntry[]) => void;
  dismissBatch: () => void;
}

export const useSidecarUpdateStore = create<State>((set, get) => ({
  updates: {},
  versions: {},
  batch: null,

  begin(machineId, machineName, fromVersion) {
    set({
      updates: {
        ...get().updates,
        [machineId]: {
          machineId,
          machineName,
          fromVersion,
          phase: 'pending',
          dismissed: false,
          startedAt: Date.now(),
        },
      },
    });
  },
  setStarted(machineId, fromVersion) {
    upsertUpdate(set, get, machineId, (existing) => ({
      ...(existing ?? defaultEntry(machineId, fromVersion)),
      fromVersion,
      phase: 'started',
      dismissed: false,
    }));
  },
  setDownloaded(machineId, fromVersion, toVersion, restartMode) {
    upsertUpdate(set, get, machineId, (existing) => ({
      ...(existing ?? defaultEntry(machineId, fromVersion)),
      fromVersion,
      toVersion,
      restartMode,
      phase: 'downloaded',
      dismissed: false,
    }));
  },
  setCompleted(machineId, fromVersion, toVersion) {
    upsertUpdate(set, get, machineId, (existing) => ({
      ...(existing ?? defaultEntry(machineId, fromVersion)),
      fromVersion,
      toVersion,
      phase: 'completed',
      dismissed: false,
    }));
  },
  setFailed(machineId, fromVersion, reason) {
    upsertUpdate(set, get, machineId, (existing) => ({
      ...(existing ?? defaultEntry(machineId, fromVersion)),
      fromVersion,
      error: reason,
      phase: 'failed',
      dismissed: false,
    }));
  },
  dismiss(machineId) {
    const existing = get().updates[machineId];
    if (!existing) return;
    set({
      updates: {
        ...get().updates,
        [machineId]: { ...existing, dismissed: true },
      },
    });
  },

  setVersionInfo(machineId, info) {
    set({ versions: { ...get().versions, [machineId]: info } });
  },
  isUpdateAvailable(machineId) {
    return !!get().versions[machineId]?.updateAvailable;
  },

  setBatch(batch) {
    set({ batch });
  },
  updateBatch(batchId, plan) {
    const cur = get().batch;
    if (!cur || cur.batchId !== batchId) return;
    set({ batch: { ...cur, plan } });
  },
  dismissBatch() {
    const cur = get().batch;
    if (!cur) return;
    set({ batch: { ...cur, dismissed: true } });
  },
}));

function upsertUpdate(
  set: (s: Partial<State>) => void,
  get: () => State,
  machineId: string,
  next: (existing: MachineUpdate | undefined) => MachineUpdate,
) {
  set({
    updates: {
      ...get().updates,
      [machineId]: next(get().updates[machineId]),
    },
  });
}

function defaultEntry(machineId: string, fromVersion: string): MachineUpdate {
  return {
    machineId,
    machineName: machineId,
    fromVersion,
    phase: 'pending',
    dismissed: false,
    startedAt: Date.now(),
  };
}
