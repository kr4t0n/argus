import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  /** machineId → icon key chosen via the machine-icon picker. Unset
   *  means "use the default" (Server). */
  machineIcons: Record<string, string>;
  toggleSidebar: () => void;
  setSidebarWidth: (w: number) => void;
  toggleContextPane: () => void;
  setContextPaneWidth: (w: number) => void;
  toggleAgentExpanded: (id: string, expanded?: boolean) => void;
  toggleShowArchived: (agentId: string) => void;
  toggleShowArchivedAgents: () => void;
  setDraft: (agentId: string, v: string) => void;
  setMachineIcon: (machineId: string, iconKey: string) => void;
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
      machineIcons: {},
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
      setMachineIcon(machineId, iconKey) {
        set({ machineIcons: { ...get().machineIcons, [machineId]: iconKey } });
      },
    }),
    { name: 'argus.ui' },
  ),
);
