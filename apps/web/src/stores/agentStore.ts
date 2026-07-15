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
  remove: (id: string) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: {},
  order: [],
  loading: false,
  // No-op since Phase 4: agents are retired, GET /agents is gone. The
  // store stays empty; sessions drive the sidebar via projectId. Kept
  // as an empty store so the remaining `useAgentStore` readers (which
  // all treat a missing agent as "unknown") compile and degrade to
  // their project/session fallbacks.
  async load() {
    /* agents retired — nothing to load */
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
  remove(id) {
    const next = { ...get().agents };
    delete next[id];
    set({
      agents: next,
      order: get().order.filter((x) => x !== id),
    });
  },
}));

/**
 * Pick the agents that belong to a given machine, in global sort order.
 * Pure helper — call from a `useMemo`/component, *not* as a zustand
 * selector. Returning a freshly-allocated array on every snapshot would
 * make `useSyncExternalStore` think the slice changed every render and
 * trip React's infinite-loop guard.
 */
export function selectAgentsForMachine(
  state: { agents: Record<string, AgentDTO>; order: string[] },
  machineId: string,
): AgentDTO[] {
  return state.order
    .map((id) => state.agents[id]!)
    .filter((a) => a && a.machineId === machineId);
}

function sortOrder(order: string[], agents: Record<string, AgentDTO>): string[] {
  // Only reachable-vs-offline matters for ordering. Bucketing `busy` /
  // `error` alongside `online` keeps a row from jumping every time the
  // user sends a command (online → busy → online) or an adapter hiccups.
  const statusWeight: Record<AgentDTO['status'], number> = {
    online: 0,
    busy: 0,
    error: 0,
    offline: 1,
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
    // Group by machine first so the Sidebar can render contiguous
    // sub-sections without resorting after the fact.
    const ms = a.machineName.localeCompare(b.machineName);
    if (ms !== 0) return ms;
    const ts = a.type.localeCompare(b.type);
    if (ts !== 0) return ts;
    return a.name.localeCompare(b.name);
  });
}
