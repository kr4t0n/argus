import { create } from 'zustand';
import type { MachineDTO } from '@argus/shared-types';
import { api } from '../lib/api';

/**
 * In-memory mirror of the server's machine roster. Hydrated on
 * dashboard mount, then kept warm by `machine:upsert` / `machine:status`
 * / `machine:removed` WebSocket events out of `useStreamSocket`.
 *
 * Sort order: live machines first, then offline; alphabetical within
 * each bucket. The sidebar groups agents under their parent machine
 * row, so this order also drives section ordering.
 */
interface MachineState {
  machines: Record<string, MachineDTO>;
  order: string[];
  loading: boolean;
  load: () => Promise<void>;
  upsert: (m: MachineDTO) => void;
  setStatus: (id: string, status: MachineDTO['status']) => void;
  remove: (id: string) => void;
}

export const useMachineStore = create<MachineState>((set, get) => ({
  machines: {},
  order: [],
  loading: false,
  async load() {
    set({ loading: true });
    const list = await api.listMachines({ includeArchived: true });
    const machines: Record<string, MachineDTO> = {};
    const order: string[] = [];
    for (const m of list) {
      machines[m.id] = m;
      order.push(m.id);
    }
    set({ machines, order: sortOrder(order, machines), loading: false });
  },
  upsert(m) {
    const machines = { ...get().machines, [m.id]: m };
    const order = get().order.includes(m.id) ? get().order : [...get().order, m.id];
    set({ machines, order: sortOrder(order, machines) });
  },
  setStatus(id, status) {
    const existing = get().machines[id];
    if (!existing) return;
    const machines = { ...get().machines, [id]: { ...existing, status } };
    set({ machines, order: sortOrder(get().order, machines) });
  },
  remove(id) {
    const next = { ...get().machines };
    delete next[id];
    set({
      machines: next,
      order: get().order.filter((x) => x !== id),
    });
  },
}));

function sortOrder(order: string[], machines: Record<string, MachineDTO>): string[] {
  const statusWeight: Record<MachineDTO['status'], number> = {
    online: 0,
    offline: 1,
  };
  return [...new Set(order)].sort((aId, bId) => {
    const a = machines[aId];
    const b = machines[bId];
    if (!a || !b) return 0;
    const aw = a.archivedAt ? 1 : 0;
    const bw = b.archivedAt ? 1 : 0;
    if (aw !== bw) return aw - bw;
    const sw = statusWeight[a.status] - statusWeight[b.status];
    if (sw !== 0) return sw;
    return a.name.localeCompare(b.name);
  });
}
