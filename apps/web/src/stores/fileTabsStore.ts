import { create } from 'zustand';
import type { FSReadResult } from '@argus/shared-types';

/**
 * In-session state for the main-area file preview tabs.
 *
 * Kept separate from `uiStore` (which is persisted to localStorage)
 * because we deliberately don't persist open files: the entries would
 * just be paths we'd have to re-fetch on every reload, with no way to
 * tell stale entries (file deleted, agent gone) from live ones until
 * the fetch fails. Persistence here belongs with a future "recent
 * files" UI, not silently behind a tab strip.
 *
 * `activeKey === null` means the chat tab is selected — chat is
 * always the first tab when any file tabs exist. The tab strip itself
 * is hidden when `openFiles` is empty so the dashboard reads the same
 * as before this feature shipped.
 */

interface OpenFileBase {
  key: string;
  /** Owning agent/session context — scopes the tab strip and lets
   *  clearAgent drop tabs when navigating away. */
  agentId: string;
  /** Tab label. */
  name: string;
}

/** A file from the agent's working directory, fetched via fs-read. */
export interface OpenWorkingFile extends OpenFileBase {
  kind: 'file';
  path: string;
}

/** An uploaded attachment, fetched over HTTP from its tokenized url. Opens
 *  in the same viewer as a working file (double-click → tab) so the
 *  file-open UX is uniform across the file tree and the chat transcript. */
export interface OpenAttachment extends OpenFileBase {
  kind: 'attachment';
  url: string;
  mime: string;
  size: number;
}

export type OpenFile = OpenWorkingFile | OpenAttachment;

export type FileContentState =
  | { status: 'loading' }
  | { status: 'ready'; result: FSReadResult }
  | { status: 'error'; message: string };

interface FileTabsState {
  openFiles: OpenFile[];
  /** null = chat tab is active. */
  activeKey: string | null;
  contents: Record<string, FileContentState>;

  openFile: (file: { agentId: string; path: string }) => void;
  openAttachment: (att: {
    agentId: string;
    id: string;
    url: string;
    name: string;
    mime: string;
    size: number;
  }) => void;
  closeFile: (key: string) => void;
  setActive: (key: string | null) => void;
  setContent: (key: string, state: FileContentState) => void;
  /** Drop every tab + cached content for an agent (e.g. agent removed
   *  or the user navigated to a different agent's session). */
  clearAgent: (agentId: string) => void;
}

export const fileKey = (agentId: string, path: string) => `${agentId}:${path}`;
export const attachmentKey = (id: string) => `att:${id}`;

const fileName = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
};

export const useFileTabsStore = create<FileTabsState>((set, get) => ({
  openFiles: [],
  activeKey: null,
  contents: {},

  openFile({ agentId, path }) {
    const key = fileKey(agentId, path);
    const existing = get().openFiles.find((f) => f.key === key);
    if (existing) {
      set({ activeKey: key });
      return;
    }
    set((s) => ({
      openFiles: [...s.openFiles, { kind: 'file', key, agentId, path, name: fileName(path) }],
      activeKey: key,
    }));
  },

  openAttachment({ agentId, id, url, name, mime, size }) {
    const key = attachmentKey(id);
    if (get().openFiles.some((f) => f.key === key)) {
      set({ activeKey: key });
      return;
    }
    set((s) => ({
      openFiles: [...s.openFiles, { kind: 'attachment', key, agentId, name, url, mime, size }],
      activeKey: key,
    }));
  },

  closeFile(key) {
    set((s) => {
      const idx = s.openFiles.findIndex((f) => f.key === key);
      if (idx === -1) return s;
      const remaining = s.openFiles.filter((f) => f.key !== key);
      // If we're closing the active tab, focus the right-side neighbor
      // (or the left if it was the last), and fall back to chat (null)
      // when no file tabs remain.
      let nextActive = s.activeKey;
      if (s.activeKey === key) {
        if (remaining.length === 0) nextActive = null;
        else nextActive = (remaining[idx] ?? remaining[idx - 1] ?? remaining[0]).key;
      }
      const contents = { ...s.contents };
      delete contents[key];
      return { openFiles: remaining, activeKey: nextActive, contents };
    });
  },

  setActive(key) {
    set({ activeKey: key });
  },

  setContent(key, state) {
    set((s) => ({ contents: { ...s.contents, [key]: state } }));
  },

  clearAgent(agentId) {
    set((s) => {
      const remaining = s.openFiles.filter((f) => f.agentId !== agentId);
      const keep = new Set(remaining.map((f) => f.key));
      const contents: Record<string, FileContentState> = {};
      for (const k of Object.keys(s.contents)) {
        if (keep.has(k)) contents[k] = s.contents[k];
      }
      const activeKey =
        s.activeKey && keep.has(s.activeKey) ? s.activeKey : null;
      return { openFiles: remaining, activeKey, contents };
    });
  },
}));
