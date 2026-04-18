import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  sidebarWidth: number;
  contextPaneOpen: boolean;
  expanded: Record<string, boolean>;
  /** agentId → whether archived sessions are visible for that agent. */
  showArchived: Record<string, boolean>;
  /** Global toggle: show archived agents in the sidebar. */
  showArchivedAgents: boolean;
  drafts: Record<string, string>;
  setSidebarWidth: (w: number) => void;
  toggleContextPane: () => void;
  toggleAgentExpanded: (id: string, expanded?: boolean) => void;
  toggleShowArchived: (agentId: string) => void;
  toggleShowArchivedAgents: () => void;
  setDraft: (agentId: string, v: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarWidth: 320,
      contextPaneOpen: true,
      expanded: {},
      showArchived: {},
      showArchivedAgents: false,
      drafts: {},
      setSidebarWidth(w) {
        set({ sidebarWidth: Math.max(220, Math.min(520, w)) });
      },
      toggleContextPane() {
        set({ contextPaneOpen: !get().contextPaneOpen });
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
    }),
    { name: 'argus.ui' },
  ),
);
