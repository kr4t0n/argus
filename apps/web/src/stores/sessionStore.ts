import { create } from 'zustand';
import type {
  CommandDTO,
  ResultChunkDTO,
  SessionDTO,
  SessionStatusEvent,
} from '@argus/shared-types';
import { api } from '../lib/api';

interface SessionEntry {
  session: SessionDTO;
  commands: CommandDTO[];
  chunks: ResultChunkDTO[];
  lastSeq: number;
  loaded: boolean;
  /** True iff there are older commands on the server that haven't been
   *  loaded yet. Initial load fetches a tail window; the UI pages older
   *  turns in on scroll-up until this goes false. */
  hasMore: boolean;
  loadingOlder: boolean;
}

/** Default initial window for `loadSession`. Small enough to keep paint
 *  snappy on long sessions, large enough that most active sessions fit
 *  entirely and never trigger a scroll-up fetch. */
const DEFAULT_TAIL = 20;
const OLDER_PAGE = 20;

interface SessionState {
  sessions: Record<string, SessionDTO>;
  order: string[];
  entries: Record<string, SessionEntry>;
  loading: boolean;

  loadList: () => Promise<void>;
  /** Load (or re-load) a session's tail window. The cached entry is
   *  reused when present; pass `force: true` to bypass the cache and
   *  refetch — used when re-entering a session after navigating away,
   *  to pick up any chunks that landed while we were unsubscribed
   *  from its WS room. */
  loadSession: (id: string, opts?: { force?: boolean }) => Promise<SessionEntry>;
  /** Fetch the next page of older commands for a session already in the
   *  store. No-op if nothing more is available or a fetch is in flight. */
  loadOlder: (id: string) => Promise<void>;

  upsertSession: (s: SessionDTO) => void;
  /** Apply a `session:status` WS event (status + unread) to the list and
   *  any cached entry, guarded by `updatedAt` so a stale echo can't
   *  resurrect a dot the user already cleared. */
  applySessionStatus: (ev: SessionStatusEvent) => void;
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

/**
 * A session write is stale if we've already applied one with a newer
 * `updatedAt`. Every server-side status/unread write bumps `updatedAt`
 * (Prisma `@updatedAt`), so this totally orders the otherwise-unordered
 * mix of WS `session:status` events and REST `loadSession` responses.
 * Without it, a late-arriving `loadSession` snapshot (captured before a
 * `markSeen` cleared `unread`) could resurrect a sidebar dot the user
 * had already dismissed — the original "green dot won't clear" race.
 * Equal timestamps are treated as fresh (idempotent re-apply).
 */
function isStaleUpdate(prev: SessionDTO | undefined, nextUpdatedAt: string): boolean {
  return !!prev && nextUpdatedAt < prev.updatedAt;
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

  async loadSession(id, opts) {
    const existing = get().entries[id];
    if (existing?.loaded && !opts?.force) return existing;
    const data = await api.getSession(id, { tailCommands: DEFAULT_TAIL });
    // lastSeq tracks the high-water-mark seq we've seen across the whole
    // session — NOT just what we loaded. Reconnect backfill uses this to
    // request new chunks only, so we must seed it from ALL loaded chunks
    // (including older commands fetched later via loadOlder; those are
    // always <= the current max seq so the max stays monotonic).
    const lastSeq = data.chunks.reduce((m, c) => Math.max(m, c.seq), 0);
    // A concurrent status write (e.g. `markSeen` flipping `unread`) may
    // have landed via WS while this GET was in flight, carrying a newer
    // `updatedAt`. Keep the fresher session row rather than letting this
    // snapshot roll back status/unread. Chunks/commands below still
    // merge in regardless — only the session row is gated.
    const prevSession = get().sessions[id];
    const session = isStaleUpdate(prevSession, data.session.updatedAt)
      ? prevSession!
      : data.session;
    const entry: SessionEntry = {
      session,
      commands: data.commands,
      chunks: data.chunks.slice().sort(bySeq),
      lastSeq,
      loaded: true,
      hasMore: data.hasMore,
      loadingOlder: false,
    };
    const sessions = { ...get().sessions, [id]: session };
    set({
      entries: { ...get().entries, [id]: entry },
      sessions,
      order: sortOrder(sessions),
    });
    return entry;
  },

  async loadOlder(id) {
    const e = get().entries[id];
    if (!e || !e.hasMore || e.loadingOlder || e.commands.length === 0) return;
    const anchor = e.commands[0]!; // oldest loaded command
    set({
      entries: { ...get().entries, [id]: { ...e, loadingOlder: true } },
    });
    try {
      const data = await api.getSessionHistory(id, anchor.id, OLDER_PAGE);
      // Re-read the entry after await — the live turn may have appended
      // chunks or a new command while the fetch was in flight, so we
      // must merge against the CURRENT state rather than the snapshot
      // we captured before the request.
      const cur = get().entries[id];
      if (!cur) return;
      // Prepend the new older commands; skip any the current state
      // somehow already has (shouldn't happen with cursor pagination,
      // but cheap to guard).
      const seenCmd = new Set(cur.commands.map((c) => c.id));
      const newCommands = data.commands.filter((c) => !seenCmd.has(c.id));
      const commands = [...newCommands, ...cur.commands];
      const seenChunk = new Set(cur.chunks.map((c) => c.id));
      const newChunks = data.chunks.filter((c) => !seenChunk.has(c.id));
      // Append then sort — chunks carry their own (commandId, seq) order
      // so placement in the array doesn't affect rendering.
      const chunks = [...cur.chunks, ...newChunks].sort(bySeq);
      set({
        entries: {
          ...get().entries,
          [id]: {
            ...cur,
            commands,
            chunks,
            hasMore: data.hasMore,
            loadingOlder: false,
          },
        },
      });
    } catch {
      const cur = get().entries[id];
      if (!cur) return;
      set({
        entries: { ...get().entries, [id]: { ...cur, loadingOlder: false } },
      });
    }
  },

  upsertSession(s) {
    // Drop a stale full-DTO upsert (e.g. a reordered session:updated) so
    // it can't roll back a newer status/unread write we already applied.
    if (isStaleUpdate(get().sessions[s.id], s.updatedAt)) return;
    const sessions = { ...get().sessions, [s.id]: s };
    const entries = get().entries[s.id]
      ? { ...get().entries, [s.id]: { ...get().entries[s.id]!, session: s } }
      : get().entries;
    set({ sessions, order: sortOrder(sessions), entries });
  },

  applySessionStatus(ev) {
    const prev = get().sessions[ev.id];
    // Not in the list yet (never loaded this page-load) — a
    // session:created/updated will populate it with the right state.
    if (!prev) return;
    if (isStaleUpdate(prev, ev.updatedAt)) return;
    const next: SessionDTO = {
      ...prev,
      status: ev.status,
      unread: ev.unread,
      updatedAt: ev.updatedAt,
    };
    const sessions = { ...get().sessions, [ev.id]: next };
    const e = get().entries[ev.id];
    const entries = e ? { ...get().entries, [ev.id]: { ...e, session: next } } : get().entries;
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
    // Preserve attachments across hot-path updates: cancel/finalize emit a
    // CommandDTO without `attachments`, while the creation and load paths
    // are the source of truth for them. Without this merge, a status flip
    // would wipe a turn's thumbnails.
    const existing = idx >= 0 ? e.commands[idx] : undefined;
    const merged =
      existing && !c.attachments?.length && existing.attachments?.length
        ? { ...c, attachments: existing.attachments }
        : c;
    const commands =
      idx >= 0 ? e.commands.map((x) => (x.id === c.id ? merged : x)) : [...e.commands, merged];
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
