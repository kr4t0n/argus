import { create } from 'zustand';
import type { FSReadResult } from '@argus/shared-types';
import type { ProjectRef } from '../lib/projects';

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
  /** Owning project id — scopes the tab strip to the current session's
   *  project (Phase 4 prep: tabs no longer know about agents). */
  scope: string;
  /** Tab label. */
  name: string;
}

/** A file from the agent's working directory, fetched via fs-read. */
export interface OpenWorkingFile extends OpenFileBase {
  kind: 'file';
  /** Full addressing for the viewer's fs-read — kept on the tab so a
   *  tab outlives store churn in the project rows. */
  project: ProjectRef;
  path: string;
  /** 1-based line to scroll to / highlight, from `path:line` citations.
   *  Not part of `key` — reopening the same file at a different line
   *  retargets the existing tab instead of spawning a duplicate. */
  line?: number;
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
  /** `revision` is the `revisions[key]` value this content was read at.
   *  It's what lets the viewer tell "already up to date" (re-focusing a
   *  tab) apart from "stale" (a CLI wrote the file while you were
   *  elsewhere), so switching tabs doesn't re-issue an fs-read. */
  | { status: 'ready'; result: FSReadResult; revision: number }
  | { status: 'error'; message: string };

interface FileTabsState {
  openFiles: OpenFile[];
  /** null = chat tab is active. */
  activeKey: string | null;
  contents: Record<string, FileContentState>;
  /** Bumped per tab when a CLI writes into that file's directory. The
   *  viewer's fetch effect keys off this, so a bump — not a content
   *  write — is what re-reads the file. Absent means 0. */
  revisions: Record<string, number>;

  openFile: (file: { project: ProjectRef; path: string; line?: number }) => void;
  openAttachment: (att: {
    scope: string;
    id: string;
    url: string;
    name: string;
    mime: string;
    size: number;
  }) => void;
  closeFile: (key: string) => void;
  setActive: (key: string | null) => void;
  setContent: (key: string, state: FileContentState) => void;
  /**
   * Mark every open working-file tab that lives directly in `dir` as
   * stale. Driven by `fs:changed`, whose payload is DIRECTORY-granular
   * (the sidecar's fsWatcher deliberately bubbles the parent and drops
   * the filename), so a sibling write invalidates too — accepted,
   * because only the focused tab actually refetches.
   *
   * `dir` is relative to the project's workingDir; '' is the root.
   */
  invalidateDir: (scope: string, dir: string) => void;
  /** Drop every tab + cached content for a project scope. */
  clearScope: (scope: string) => void;
}

export const fileKey = (scope: string, path: string) => `${scope}:${path}`;
export const attachmentKey = (id: string) => `att:${id}`;

const fileName = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
};

/** Parent directory of a workingDir-relative path. Root-level files
 *  yield '' — matching how the sidecar reports the watched root — NOT
 *  '.', which is what a naive posix dirname would give. */
const dirName = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

export const useFileTabsStore = create<FileTabsState>((set, get) => ({
  openFiles: [],
  activeKey: null,
  contents: {},
  revisions: {},

  openFile({ project, path, line }) {
    const key = fileKey(project.projectId, path);
    const existing = get().openFiles.find((f) => f.key === key);
    if (existing) {
      // Refresh `line` on the existing tab so a second citation into the
      // same file re-scrolls the already-open viewer (or clears the
      // highlight when the new open has no line).
      set((s) => ({
        activeKey: key,
        openFiles: s.openFiles.map((f) =>
          f.key === key && f.kind === 'file' ? { ...f, line } : f,
        ),
      }));
      return;
    }
    set((s) => ({
      openFiles: [
        ...s.openFiles,
        { kind: 'file', key, scope: project.projectId, project, path, name: fileName(path), line },
      ],
      activeKey: key,
    }));
  },

  openAttachment({ scope, id, url, name, mime, size }) {
    const key = attachmentKey(id);
    if (get().openFiles.some((f) => f.key === key)) {
      set({ activeKey: key });
      return;
    }
    set((s) => ({
      openFiles: [...s.openFiles, { kind: 'attachment', key, scope, name, url, mime, size }],
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
      const revisions = { ...s.revisions };
      delete revisions[key];
      return { openFiles: remaining, activeKey: nextActive, contents, revisions };
    });
  },

  setActive(key) {
    set({ activeKey: key });
  },

  setContent(key, state) {
    set((s) => ({ contents: { ...s.contents, [key]: state } }));
  },

  invalidateDir(scope, dir) {
    set((s) => {
      const hits = s.openFiles.filter(
        (f) => f.kind === 'file' && f.scope === scope && dirName(f.path) === dir,
      );
      // Return the SAME state object when nothing matched: a new
      // `revisions` identity on every unrelated fs event would re-render
      // every subscriber for nothing.
      if (hits.length === 0) return s;
      const revisions = { ...s.revisions };
      for (const f of hits) revisions[f.key] = (revisions[f.key] ?? 0) + 1;
      return { revisions };
    });
  },

  clearScope(scope) {
    set((s) => {
      const remaining = s.openFiles.filter((f) => f.scope !== scope);
      const keep = new Set(remaining.map((f) => f.key));
      const contents: Record<string, FileContentState> = {};
      for (const k of Object.keys(s.contents)) {
        if (keep.has(k)) contents[k] = s.contents[k];
      }
      const revisions: Record<string, number> = {};
      for (const k of Object.keys(s.revisions)) {
        if (keep.has(k)) revisions[k] = s.revisions[k];
      }
      const activeKey =
        s.activeKey && keep.has(s.activeKey) ? s.activeKey : null;
      return { openFiles: remaining, activeKey, contents, revisions };
    });
  },
}));
