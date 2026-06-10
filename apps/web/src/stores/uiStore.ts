import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * `'system'` defers to the OS via `prefers-color-scheme`; `'dark'` /
 * `'light'` are explicit overrides. Default is `'system'` so the first
 * load matches the user's OS without surprising them.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  contextPaneOpen: boolean;
  /** Persisted width of the right-hand context pane in pixels. */
  contextPaneWidth: number;
  expanded: Record<string, boolean>;
  /** agentId → whether archived sessions are visible for that agent. */
  showArchived: Record<string, boolean>;
  /** Global toggle: show archived agents in the sidebar. */
  showArchivedAgents: boolean;
  drafts: Record<string, string>;
  /** User's theme preference. The resolved (system → light/dark) value
   *  is applied to <html> as the `dark` class by `applyTheme()`. */
  theme: ThemePreference;
  /** Global on/off for desktop notifications + completion sound when a
   *  command finishes outside the active session route. Off by default —
   *  the OS permission prompt only fires the first time the user flips
   *  this on (must be in a user-gesture handler, see `lib/notifications`).
   *  Even when this is `true`, the fire-time path still re-checks
   *  `Notification.permission` so a user who revokes permission in
   *  browser settings silently no-ops without us re-prompting. */
  notificationsEnabled: boolean;
  /** Extensions → Notes: when on, the session right-pane gains a "Note"
   *  tab beside Terminal for per-project scratchpad notes. The server is
   *  the source of truth (an account-level preference synced across
   *  browsers via `/me/extensions`); this persisted copy is a cache so
   *  the UI reads it synchronously with no flash, reconciled against the
   *  server on bootstrap (see App.tsx). Off by default — extensions are
   *  opt-in. */
  notesExtensionEnabled: boolean;
  /** Extensions → Progress: when on, the session right-pane gains a
   *  "Progress" tab that lists live background tasks reported by
   *  `argus-bg` for the project. Same caching scheme as
   *  notesExtensionEnabled. */
  progressExtensionEnabled: boolean;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  toggleContextPane: () => void;
  setContextPaneWidth: (w: number) => void;
  toggleAgentExpanded: (id: string, expanded?: boolean) => void;
  toggleShowArchived: (agentId: string) => void;
  toggleShowArchivedAgents: () => void;
  setDraft: (agentId: string, v: string) => void;
  setTheme: (t: ThemePreference) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setNotesExtensionEnabled: (v: boolean) => void;
  setProgressExtensionEnabled: (v: boolean) => void;
}

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;
export const CONTEXT_PANE_MIN = 240;
export const CONTEXT_PANE_MAX = 720;

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      sidebarWidth: 320,
      contextPaneOpen: true,
      contextPaneWidth: 320,
      expanded: {},
      showArchived: {},
      showArchivedAgents: false,
      drafts: {},
      theme: 'system',
      notificationsEnabled: false,
      notesExtensionEnabled: false,
      progressExtensionEnabled: false,
      toggleSidebar() {
        set({ sidebarOpen: !get().sidebarOpen });
      },
      setSidebarWidth(w) {
        set({ sidebarWidth: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w))) });
      },
      toggleContextPane() {
        set({ contextPaneOpen: !get().contextPaneOpen });
      },
      setContextPaneWidth(w) {
        set({
          contextPaneWidth: Math.max(CONTEXT_PANE_MIN, Math.min(CONTEXT_PANE_MAX, Math.round(w))),
        });
      },
      toggleAgentExpanded(id, expanded) {
        const current = get().expanded[id] ?? true;
        set({
          expanded: {
            ...get().expanded,
            [id]: expanded ?? !current,
          },
        });
      },
      toggleShowArchived(agentId) {
        const current = get().showArchived[agentId] ?? false;
        set({
          showArchived: { ...get().showArchived, [agentId]: !current },
        });
      },
      toggleShowArchivedAgents() {
        set({ showArchivedAgents: !get().showArchivedAgents });
      },
      setDraft(agentId, v) {
        set({ drafts: { ...get().drafts, [agentId]: v } });
      },
      setTheme(t) {
        set({ theme: t });
      },
      setNotificationsEnabled(v) {
        set({ notificationsEnabled: v });
      },
      setNotesExtensionEnabled(v) {
        set({ notesExtensionEnabled: v });
      },
      setProgressExtensionEnabled(v) {
        set({ progressExtensionEnabled: v });
      },
    }),
    { name: 'argus.ui' },
  ),
);
