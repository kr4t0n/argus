import { create } from 'zustand';
import type { AgentDTO } from '@argus/shared-types';
import { api } from '../lib/api';

interface AgentState {
  agents: Record<string, AgentDTO>;
  order: string[];
  loading: boolean;
  load: () => Promise<void>;
  upsert: (a: AgentDTO) => void;
  setStatus: (id: string, status: AgentDTO['status']) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: {},
  order: [],
  loading: false,
  async load() {
    set({ loading: true });
    // Always fetch *all* agents (archived included). The sidebar filters
    // archived ones out by default but the data needs to be there so the
    // user can flip the toggle without a refetch.
    const list = await api.listAgents({ includeArchived: true });
    const agents: Record<string, AgentDTO> = {};
    const order: string[] = [];
    for (const a of list) {
      agents[a.id] = a;
      order.push(a.id);
    }
    set({ agents, order: sortOrder(order, agents), loading: false });
  },
  upsert(a) {
    const agents = { ...get().agents, [a.id]: a };
    const order = get().order.includes(a.id) ? get().order : [...get().order, a.id];
    set({ agents, order: sortOrder(order, agents) });
  },
  setStatus(id, status) {
    const existing = get().agents[id];
    if (!existing) return;
    const agents = { ...get().agents, [id]: { ...existing, status } };
    set({ agents, order: sortOrder(get().order, agents) });
  },
}));

function sortOrder(order: string[], agents: Record<string, AgentDTO>): string[] {
  const statusWeight: Record<AgentDTO['status'], number> = {
    online: 0,
    busy: 1,
    error: 2,
    offline: 3,
  };
  return [...new Set(order)].sort((aId, bId) => {
    const a = agents[aId];
    const b = agents[bId];
    if (!a || !b) return 0;
    // Archived agents always sink to the bottom regardless of status.
    const aw = a.archivedAt ? 1 : 0;
    const bw = b.archivedAt ? 1 : 0;
    if (aw !== bw) return aw - bw;
    const sw = statusWeight[a.status] - statusWeight[b.status];
    if (sw !== 0) return sw;
    const ts = a.type.localeCompare(b.type);
    if (ts !== 0) return ts;
    return a.machine.localeCompare(b.machine);
  });
}
