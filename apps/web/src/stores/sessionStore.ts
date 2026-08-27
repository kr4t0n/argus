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
  /**
   * True iff NEWER commands exist below the window — i.e. the window does
   * NOT reach the session's newest turn.
   *
   * This is the transcript window invariant, and everything live keys off
   * it:
   *
   *   hasMoreNewer === false  ⟺  window reaches the newest turn
   *                           ⟺  live appends are safe.
   *
   * Only a deep-link load (`loadSessionAround`) can set it true. While it
   * is true, `appendChunk` and `upsertCommand` must DROP anything for a
   * turn outside the window — appending would splice turn 210 directly
   * below turn 34 and render a discontiguous transcript. Tail loads always
   * reset it to false.
   */
  hasMoreNewer: boolean;
  loadingNewer: boolean;
  /** The turn a deep link asked for, if this window came from one. Drives
   *  the scroll-to + highlight in the viewer; cleared once consumed. */
  focusCommandId: string | null;
}

/** Default initial window for `loadSession`. Deliberately small: the
 *  open-a-session cost scales with chunks per turn, not turn count
 *  (agentic turns carry tool meta, diffs, and thinking text), so a
 *  short tail keeps first paint fast; scroll-up pages the rest in. */
const DEFAULT_TAIL = 4;
const OLDER_PAGE = 20;
/** Turns of context loaded either side of a deep-link anchor. Asymmetric
 *  on purpose: the target lands slightly below the top of the viewport,
 *  so a little history above it reads as context rather than a hard cut.
 *  Small because the payload is dominated by chunks per turn, not turn
 *  count — the same reason DEFAULT_TAIL is 4. */
const AROUND_BEFORE = 5;
const AROUND_AFTER = 4;

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
  /**
   * Load a window CENTRED on `commandId` instead of the tail — the
   * deep-link path (⌘K search result → the turn that matched). Always
   * refetches: the caller is asking to be moved somewhere specific, so a
   * cached tail window is never an acceptable answer.
   *
   * The resulting window may not reach the newest turn (`hasMoreNewer`).
   */
  loadSessionAround: (id: string, commandId: string) => Promise<SessionEntry>;
  /** Fetch the next page of NEWER commands. Only meaningful while
   *  `hasMoreNewer` — a tail window has nothing newer to page. */
  loadNewer: (id: string) => Promise<void>;
  /** Clear the deep-link focus marker once the viewer has scrolled to it,
   *  so re-renders don't keep yanking the user back to that turn. */
  clearFocusCommand: (id: string) => void;

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

/** Ascending turn order, matching what the server returns and the viewer
 *  renders. `id` breaks createdAt ties so the order is total — two turns
 *  can share a millisecond. */
function byCreatedAt(a: CommandDTO, b: CommandDTO) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
    // A cached DEEP-LINKED window is never a valid answer here: plain
    // navigation into a session means "show me the present", and a
    // floating window would drop the user back into the middle of history
    // with live turns invisible. Only an explicit loadSessionAround call
    // puts the viewer off the tail, so reaching this function is itself
    // the signal to come back.
    const stale = !!existing?.hasMoreNewer;
    if (existing?.loaded && !opts?.force && !stale) return existing;
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
      commands: data.commands.slice().sort(byCreatedAt),
      chunks: data.chunks.slice().sort(bySeq),
      lastSeq,
      loaded: true,
      hasMore: data.hasMore,
      loadingOlder: false,
      // A tail window reaches the newest turn by construction, which is
      // what re-arms live append / stick-to-bottom.
      hasMoreNewer: false,
      loadingNewer: false,
      focusCommandId: null,
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

  async loadSessionAround(id, commandId) {
    const data = await api.getSession(id, {
      aroundCommand: commandId,
      beforeCount: AROUND_BEFORE,
      afterCount: AROUND_AFTER,
    });
    const prevSession = get().sessions[id];
    const session = isStaleUpdate(prevSession, data.session.updatedAt)
      ? prevSession!
      : data.session;
    const entry: SessionEntry = {
      session,
      commands: data.commands.slice().sort(byCreatedAt),
      chunks: data.chunks.slice().sort(bySeq),
      // `seq` restarts per command, so this is a per-window high-water
      // mark, not a session-wide one. It is only ever used by the
      // reconnect backfill, which `hasMoreNewer` gates off entirely for a
      // floating window — see the backfill comment.
      lastSeq: data.chunks.reduce((m, c) => Math.max(m, c.seq), 0),
      loaded: true,
      hasMore: data.hasMore,
      loadingOlder: false,
      hasMoreNewer: data.hasMoreNewer,
      loadingNewer: false,
      focusCommandId: commandId,
    };
    const sessions = { ...get().sessions, [id]: session };
    set({
      entries: { ...get().entries, [id]: entry },
      sessions,
      order: sortOrder(sessions),
    });
    return entry;
  },

  async loadNewer(id) {
    const e = get().entries[id];
    if (!e || !e.hasMoreNewer || e.loadingNewer || e.commands.length === 0) return;
    const anchor = e.commands[e.commands.length - 1]!; // newest loaded
    set({ entries: { ...get().entries, [id]: { ...e, loadingNewer: true } } });
    try {
      const data = await api.getSessionHistoryAfter(id, anchor.id, OLDER_PAGE);
      // Re-read after the await: the window may have moved under us (the
      // user could have hit "jump to latest" mid-flight, which resets to a
      // tail window). Merging this page into a window that is no longer
      // floating would re-introduce the discontiguity we are avoiding.
      const cur = get().entries[id];
      if (!cur || !cur.hasMoreNewer) return;
      const seenCmd = new Set(cur.commands.map((c) => c.id));
      const newCommands = data.commands.filter((c) => !seenCmd.has(c.id));
      const seenChunk = new Set(cur.chunks.map((c) => c.id));
      const newChunks = data.chunks.filter((c) => !seenChunk.has(c.id));
      set({
        entries: {
          ...get().entries,
          [id]: {
            ...cur,
            // Append: this page is strictly newer than everything loaded.
            commands: [...cur.commands, ...newCommands],
            chunks: [...cur.chunks, ...newChunks].sort(bySeq),
            hasMoreNewer: data.hasMore,
            loadingNewer: false,
          },
        },
      });
    } catch {
      const cur = get().entries[id];
      if (!cur) return;
      set({ entries: { ...get().entries, [id]: { ...cur, loadingNewer: false } } });
    }
  },

  clearFocusCommand(id) {
    const e = get().entries[id];
    if (!e || e.focusCommandId === null) return;
    set({ entries: { ...get().entries, [id]: { ...e, focusCommandId: null } } });
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
    // Updating a turn already in the window is always safe — it's a
    // status/usage flip for something on screen. ADDING one is only safe
    // while the window reaches the newest turn: in a floating deep-link
    // window a brand-new turn belongs hundreds of turns below what's
    // loaded, and appending it would render turn 210 directly under turn
    // 34. Drop it instead; "jump to latest" reloads the tail and picks it
    // up. See the transcript window invariant on SessionEntry.
    if (idx < 0 && e.hasMoreNewer) return;
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
    // In a floating deep-link window, only accept chunks for turns the
    // window actually holds. Without this the store accumulates chunks
    // whose command will never render — invisible, unbounded growth for as
    // long as the user sits in history while a turn streams.
    //
    // The check is deliberately NOT applied to live (tail) windows: WS
    // ordering between `command:updated` and the first chunk of a turn
    // isn't guaranteed, so a live window must accept chunks for a command
    // it hasn't been told about yet.
    if (e.hasMoreNewer && !e.commands.some((c) => c.id === chunk.commandId)) return;
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

    // `GET /sessions/:id/chunks` has no window parameters — it returns
    // EVERY command in the session. Merging that wholesale is wrong in two
    // different ways, so the merge is filtered to what the window is
    // entitled to:
    //
    //  • Floating (deep-linked) window: accept updates for turns already
    //    held and nothing else. Letting the reconnect inject the whole
    //    session would silently un-window the view the user deep-linked
    //    into.
    //  • Tail window: accept turns already held, plus any created while we
    //    were disconnected (strictly newer than the newest loaded). This
    //    also fixes a pre-existing bug — the unfiltered merge used to
    //    inject every ancient turn in the session on every reconnect,
    //    which rendered a few hundred empty turns above the tail (their
    //    chunks are filtered out by `afterSeq`, so they arrive contentless)
    //    and left `hasMore` claiming there was still more to page.
    const held = new Map(e.commands.map((c) => [c.id, c]));
    const newest = e.commands.length ? e.commands[e.commands.length - 1]!.createdAt : null;
    for (const c of commands) {
      if (held.has(c.id)) {
        held.set(c.id, c);
        continue;
      }
      if (e.hasMoreNewer) continue; // floating: never widen
      if (newest !== null && c.createdAt < newest) continue; // ancient: not ours
      held.set(c.id, c);
    }
    const mergedCommands = [...held.values()].sort(byCreatedAt);

    // Chunks for turns outside the window would never render; dropping
    // them keeps the entry from growing without bound.
    const inWindow = new Set(mergedCommands.map((c) => c.id));
    const seen = new Set(e.chunks.map((c) => c.id));
    const mergedChunks = [...e.chunks];
    for (const c of chunks) {
      if (seen.has(c.id)) continue;
      if (!inWindow.has(c.commandId)) continue;
      mergedChunks.push(c);
    }
    mergedChunks.sort(bySeq);
    const lastSeq = mergedChunks.reduce((m, c) => Math.max(m, c.seq), 0);
    set({
      entries: {
        ...get().entries,
        [id]: { ...e, chunks: mergedChunks, commands: mergedCommands, lastSeq },
      },
    });
  },
}));
