import { create } from 'zustand';
import type { CommandDTO, ResultChunkDTO, SessionDTO } from '@argus/shared-types';
import { api } from '../lib/api';

interface SessionEntry {
  session: SessionDTO;
  commands: CommandDTO[];
  chunks: ResultChunkDTO[];
  lastSeq: number;
  loaded: boolean;
}

interface SessionState {
  sessions: Record<string, SessionDTO>;
  order: string[];
  entries: Record<string, SessionEntry>;
  loading: boolean;

  loadList: () => Promise<void>;
  loadSession: (id: string) => Promise<SessionEntry>;

  upsertSession: (s: SessionDTO) => void;
  removeSession: (id: string) => void;

  upsertCommand: (c: CommandDTO) => void;
  appendChunk: (c: ResultChunkDTO) => void;
  /** After reconnect: backfill chunks from REST and merge. */
  backfill: (
    id: string,
    commands: CommandDTO[],
    chunks: ResultChunkDTO[],
  ) => void;
}

function bySeq(a: ResultChunkDTO, b: ResultChunkDTO) {
  if (a.commandId !== b.commandId) return a.commandId < b.commandId ? -1 : 1;
  return a.seq - b.seq;
}

function sortOrder(sessions: Record<string, SessionDTO>): string[] {
  return Object.values(sessions)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((s) => s.id);
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: {},
  order: [],
  entries: {},
  loading: false,

  async loadList() {
    set({ loading: true });
    // Always pull archived rows too; the sidebar filters per-agent client-side.
    const list = await api.listSessions({ includeArchived: true });
    const sessions: Record<string, SessionDTO> = {};
    for (const s of list) sessions[s.id] = s;
    set({ sessions, order: sortOrder(sessions), loading: false });
  },

  async loadSession(id) {
    const existing = get().entries[id];
    if (existing?.loaded) return existing;
    const data = await api.getSession(id);
    const lastSeq = data.chunks.reduce((m, c) => Math.max(m, c.seq), 0);
    const entry: SessionEntry = {
      session: data.session,
      commands: data.commands,
      chunks: data.chunks.slice().sort(bySeq),
      lastSeq,
      loaded: true,
    };
    const sessions = { ...get().sessions, [id]: data.session };
    set({
      entries: { ...get().entries, [id]: entry },
      sessions,
      order: sortOrder(sessions),
    });
    return entry;
  },

  upsertSession(s) {
    const sessions = { ...get().sessions, [s.id]: s };
    const entries = get().entries[s.id]
      ? { ...get().entries, [s.id]: { ...get().entries[s.id]!, session: s } }
      : get().entries;
    set({ sessions, order: sortOrder(sessions), entries });
  },

  removeSession(id) {
    const sessions = { ...get().sessions };
    const entries = { ...get().entries };
    delete sessions[id];
    delete entries[id];
    set({ sessions, order: sortOrder(sessions), entries });
  },

  upsertCommand(c) {
    const e = get().entries[c.sessionId];
    if (!e) return;
    const idx = e.commands.findIndex((x) => x.id === c.id);
    const commands = idx >= 0 ? e.commands.map((x) => (x.id === c.id ? c : x)) : [...e.commands, c];
    set({
      entries: { ...get().entries, [c.sessionId]: { ...e, commands } },
    });
  },

  appendChunk(chunk) {
    const e = get().entries[chunk.sessionId];
    if (!e) return;
    // Guard against duplicates (at-least-once delivery).
    if (e.chunks.some((x) => x.id === chunk.id)) return;
    const chunks = [...e.chunks, chunk];
    const lastSeq = Math.max(e.lastSeq, chunk.seq);
    set({
      entries: {
        ...get().entries,
        [chunk.sessionId]: { ...e, chunks, lastSeq },
      },
    });
  },

  backfill(id, commands, chunks) {
    const e = get().entries[id];
    if (!e) return;
    const seen = new Set(e.chunks.map((c) => c.id));
    const merged = [...e.chunks];
    for (const c of chunks) {
      if (!seen.has(c.id)) merged.push(c);
    }
    merged.sort(bySeq);
    const lastSeq = merged.reduce((m, c) => Math.max(m, c.seq), 0);
    const cmdMap = new Map(e.commands.map((c) => [c.id, c]));
    for (const c of commands) cmdMap.set(c.id, c);
    set({
      entries: {
        ...get().entries,
        [id]: { ...e, chunks: merged, commands: [...cmdMap.values()], lastSeq },
      },
    });
  },
}));
