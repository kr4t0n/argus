import { create } from 'zustand';

/** Which overlay is showing.
 *  - `session` (⌘P) — switch to a session by NAME. Client-side over the
 *    already-hydrated list, instant, live sessions first.
 *  - `content` (⌘K) — search what was SAID. Server-side full text,
 *    archived included.
 *  - `help` (⌘/) — the shortcuts list. It rides this field rather than
 *    owning its own open-state for exactly the reason the two palette
 *    modes do: it is a third full-screen overlay, and three of them
 *    holding independent booleans would have to negotiate who hides when
 *    another's hotkey fires. One field makes every such press a switch. */
export type PaletteMode = 'session' | 'content' | 'help';

interface PaletteState {
  /** null = closed. Collapsing open-ness and mode into one field is what
   *  makes ⌘K-while-⌘P-is-open a mode switch rather than two overlays
   *  negotiating which of them is visible. */
  mode: PaletteMode | null;
  open: (mode: PaletteMode) => void;
  close: () => void;
  /** Open in `mode`, or close if that mode is already showing — the
   *  press-again-to-dismiss behaviour of each hotkey. */
  toggle: (mode: PaletteMode) => void;
}

/**
 * Deliberately NOT part of `uiStore`: that store is wrapped in `persist`
 * with no `partialize`, so anything added there is written to
 * localStorage — and an open palette restored on reload is not a
 * preference, it's a bug.
 */
export const usePaletteStore = create<PaletteState>((set, get) => ({
  mode: null,
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),
  toggle: (mode) => set({ mode: get().mode === mode ? null : mode }),
}));
