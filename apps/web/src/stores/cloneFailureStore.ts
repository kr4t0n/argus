import { create } from 'zustand';

/**
 * Transient store for "couldn't clone CLI session state for this fork"
 * notifications. The forked Session row exists fine — the dashboard
 * already navigated to it and rendered the reproduced history — so
 * these toasts are purely informational: "the next prompt you send in
 * this session will start a fresh CLI conversation, not resume the
 * one you forked from."
 *
 * Keyed by the new session id so duplicate failure events for the same
 * session collapse into one toast (the server won't re-emit, but
 * client reconnects might re-deliver pending entries from the result
 * stream — at-least-once semantics).
 */
export interface CloneFailure {
  sessionId: string;
  /** Snapshotted at push time so the toast still has a label even if
   *  the session row hasn't fully populated yet. */
  sessionTitle: string;
  reason: string;
  startedAt: number;
}

interface CloneFailureState {
  failures: Record<string, CloneFailure>;
  push: (f: CloneFailure) => void;
  dismiss: (sessionId: string) => void;
}

export const useCloneFailureStore = create<CloneFailureState>((set) => ({
  failures: {},
  push: (f) =>
    set((s) => ({
      failures: { ...s.failures, [f.sessionId]: f },
    })),
  dismiss: (sessionId) =>
    set((s) => {
      const next = { ...s.failures };
      delete next[sessionId];
      return { failures: next };
    }),
}));
