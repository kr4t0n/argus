import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  EyeOff,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { FSEntry } from '@argus/shared-types';
import { api, ApiError } from '../lib/api';
import { joinProject, leaveProject, subscribeHandler } from '../lib/ws';
import type { ProjectRef } from '../lib/projects';
import { useFileTabsStore } from '../stores/fileTabsStore';
import { cn } from '../lib/utils';

type DirState = {
  entries: FSEntry[];
  loading: boolean;
  error?: string;
};

// How many directory levels we ask the sidecar to walk in a single
// round trip. 3 means: root + its subdirs + their subdirs are all
// populated before the user clicks anything, so the first two levels
// of expansion render synchronously from cache. Raising this trades
// larger payloads and more sidecar stat calls for deeper instant
// expansion; the sidecar bounds deeper traversal via
// FSListRecursiveDescentBudget so a pathological tree still
// terminates.
const TREE_PREFETCH_DEPTH = 3;

type Props = {
  project: ProjectRef;
};

/**
 * Lazy-expanding file tree for the project's working directory. On
 * mount and on cold expansions, fetches TREE_PREFETCH_DEPTH levels
 * in one round trip from `GET /projects/:id/fs/list` and hydrates a
 * flat `Map<path, DirState>` cache, so the next few expansions
 * render synchronously. Subscribes to `fs:changed` to re-fetch any
 * loaded level as CLIs edit files.
 *
 * Double-clicking a file opens it as a preview tab in the main pane
 * (see FileTabStrip + FileViewer).
 */
export function FileTree({ project }: Props) {
  // Keyed by path (empty string = root). We never delete entries on
  // collapse — the UI just hides them — so that re-expanding is
  // instant. Collapse → expand → instant is the cursor-style UX the
  // user expects from a tree explorer.
  const [dirs, setDirs] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // Bound to this agent so DirNode doesn't need to know about it.
  const openFile = useFileTabsStore((s) => s.openFile);
  const onOpenFile = useCallback(
    (path: string) => openFile({ project, path }),
    [project, openFile],
  );

  // Keep the latest `showAll` in a ref so the `fs:changed` handler
  // (closed over at subscribe time) always refetches with the current
  // filter, not the one at mount.
  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;

  const fetchDir = useCallback(
    async (path: string, depth: number = 1) => {
      setDirs((prev) => {
        const next = new Map(prev);
        const existing = next.get(path);
        next.set(path, {
          entries: existing?.entries ?? [],
          loading: true,
          error: undefined,
        });
        return next;
      });
      try {
        const res = await api.listProjectDir(project.projectId, path, showAllRef.current, depth);
        setDirs((prev) => {
          const next = new Map(prev);
          // Depth>1 responses hydrate every level the sidecar walked
          // in one setState so the next N expansions render from
          // cache. Depth=1 responses land in `entries` only.
          if (res.listings) {
            for (const [p, entries] of Object.entries(res.listings)) {
              next.set(p, { entries, loading: false });
            }
          }
          if (!res.listings || !res.listings[path]) {
            next.set(path, { entries: res.entries, loading: false });
          }
          return next;
        });
      } catch (err) {
        const msg =
          err instanceof ApiError ? err.message : (err as Error).message || 'listing failed';
        setDirs((prev) => {
          const next = new Map(prev);
          const existing = next.get(path);
          next.set(path, {
            entries: existing?.entries ?? [],
            loading: false,
            error: msg,
          });
          return next;
        });
      }
    },
    [project.projectId],
  );

  // Reset everything when the project changes — entries from one
  // working dir are nonsense for another.
  // The initial fetch pulls TREE_PREFETCH_DEPTH levels so the first
  // couple of expansion clicks are instant.
  useEffect(() => {
    setDirs(new Map());
    setExpanded(new Set(['']));
    setSelected(null);
    void fetchDir('', TREE_PREFETCH_DEPTH);
  }, [project.projectId, fetchDir]);

  // Filter toggle collapses back to the root and refetches with the
  // new filter — same shape as refreshAll. Skip the initial-render
  // fire so we don't double up with the agent-change effect above,
  // which already fetches the root on mount.
  const showAllMounted = useRef(false);
  useEffect(() => {
    if (!showAllMounted.current) {
      showAllMounted.current = true;
      return;
    }
    setExpanded(new Set(['']));
    setDirs(new Map());
    setSelected(null);
    void fetchDir('', TREE_PREFETCH_DEPTH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  // Live updates: sidecar fsnotify → server broadcast → we refetch
  // exactly the affected directory if we've already loaded it. Runner
  // sidecars broadcast to the project room, keyed by the
  // (machineId, workingDir) pair.
  useEffect(() => {
    joinProject(project.machineId, project.workingDir);
    const matches = (p: { machineId?: string; workingDir?: string }) =>
      !!p.workingDir && p.machineId === project.machineId && p.workingDir === project.workingDir;
    const unsubscribe = subscribeHandler({
      onFSChanged: (ev) => {
        if (!matches(ev)) return;
        setDirs((prev) => {
          if (!prev.has(ev.path)) return prev;
          // setState during setState is banned — defer the refetch so
          // the current tree render commits first.
          queueMicrotask(() => fetchDir(ev.path));
          return prev;
        });
      },
    });
    return () => {
      unsubscribe();
      leaveProject(project.machineId, project.workingDir);
    };
  }, [project.projectId, project.machineId, project.workingDir, fetchDir]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          const cached = dirs.get(path);
          if (!cached) {
            // Cold expansion — the user clicked outside the prefetch
            // window. Pull TREE_PREFETCH_DEPTH more levels starting
            // here so the next few clicks are instant too.
            void fetchDir(path, TREE_PREFETCH_DEPTH);
          } else if (!cached.loading && hasUnwalkedSubdir(cached.entries, path, dirs)) {
            // Cached — the folder itself renders instantly, but at
            // least one of its subdirs hasn't been walked yet. Fire a
            // background depth-N fetch so the frontier slides with
            // the user and their next click stays on warm cache. The
            // spinner next to the folder name honestly reflects that
            // deeper levels are loading.
            void fetchDir(path, TREE_PREFETCH_DEPTH);
          }
        }
        return next;
      });
    },
    [dirs, fetchDir],
  );

  // Refresh = start over: collapse to the root and re-pull the
  // prefetch window. Simpler than refetching every expanded level in
  // parallel, and matches what most tree explorers do.
  const refreshAll = useCallback(() => {
    setExpanded(new Set(['']));
    setDirs(new Map());
    setSelected(null);
    void fetchDir('', TREE_PREFETCH_DEPTH);
  }, [fetchDir]);

  const rootState = dirs.get('');
  const rootEmpty =
    rootState && !rootState.loading && !rootState.error && rootState.entries.length === 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-end gap-1">
        <IconButton
          title={showAll ? 'Hide gitignored' : 'Show gitignored'}
          onClick={() => setShowAll((v) => !v)}
          active={showAll}
        >
          {showAll ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
        </IconButton>
        <IconButton title="Refresh" onClick={refreshAll}>
          <RefreshCw
            className={cn('h-3 w-3', rootState?.loading && 'animate-spin text-fg-secondary')}
          />
        </IconButton>
      </div>
      <div className="h-full min-h-56 overflow-y-auto overflow-x-hidden font-mono text-[11px] leading-[22px] no-scrollbar">
        {rootState?.error && (
          <div className="px-2 py-1 text-xs text-red-500 dark:text-red-400">{rootState.error}</div>
        )}
        {rootState?.loading && !rootState.entries.length && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-fg-tertiary">
            <Loader2 className="h-3 w-3 animate-spin" /> loading…
          </div>
        )}
        {rootEmpty && <div className="px-2 py-1 text-fg-muted">empty directory</div>}
        {rootState && !rootState.error && rootState.entries.length > 0 && (
          <DirNode
            path=""
            entries={rootState.entries}
            depth={0}
            dirs={dirs}
            expanded={expanded}
            selected={selected}
            onToggle={toggleDir}
            onSelect={setSelected}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </div>
  );
}

/**
 * True when at least one of `entries`'s subdirectories doesn't have a
 * cached listing in `dirs`. Used to decide whether expanding a
 * cached folder should fire a background prefetch — if every child
 * dir is already walked, the user's next click is already instant and
 * we can stay quiet. Ignored entries are skipped to match the
 * sidecar's BFS, which also refuses to descend into them.
 */
function hasUnwalkedSubdir(
  entries: FSEntry[],
  parentPath: string,
  dirs: Map<string, DirState>,
): boolean {
  for (const e of entries) {
    if (e.kind !== 'dir' || e.gitignored) continue;
    const childPath = parentPath ? `${parentPath}/${e.name}` : e.name;
    if (!dirs.has(childPath)) return true;
  }
  return false;
}

type DirNodeProps = {
  path: string;
  entries: FSEntry[];
  depth: number;
  dirs: Map<string, DirState>;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenFile: (path: string) => void;
};

function DirNode({
  path,
  entries,
  depth,
  dirs,
  expanded,
  selected,
  onToggle,
  onSelect,
  onOpenFile,
}: DirNodeProps) {
  return (
    <ul>
      {entries.map((e) => {
        const entryPath = path ? `${path}/${e.name}` : e.name;
        const isDir = e.kind === 'dir';
        const isOpen = expanded.has(entryPath);
        const child = isDir ? dirs.get(entryPath) : undefined;
        const isSelected = selected === entryPath;
        return (
          <li key={entryPath}>
            <button
              type="button"
              onClick={() => {
                onSelect(entryPath);
                if (isDir) onToggle(entryPath);
              }}
              onDoubleClick={() => {
                if (!isDir) onOpenFile(entryPath);
              }}
              className={cn(
                'group flex w-full items-center gap-1 rounded px-1 text-left hover:bg-surface-1',
                isSelected && 'bg-surface-1 text-fg-primary',
                e.gitignored && 'opacity-60',
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
              title={
                isDir
                  ? `${entryPath}/`
                  : `${entryPath}\n${formatSize(e.size)} · ${formatMtime(e.mtime)}`
              }
            >
              {isDir ? (
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-fg-muted transition-transform',
                    isOpen && 'rotate-90 text-fg-tertiary',
                  )}
                />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              {isDir ? (
                isOpen ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-sky-400/80" />
                )
              ) : e.kind === 'symlink' ? (
                <FileText className="h-3.5 w-3.5 shrink-0 text-purple-400/80" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 text-fg-tertiary" />
              )}
              <span className="truncate text-fg-secondary group-hover:text-fg-primary">
                {e.name}
              </span>
              {child?.loading && (
                <Loader2 className="ml-auto h-3 w-3 animate-spin text-fg-muted" />
              )}
            </button>
            {isDir && isOpen && (
              <>
                {child?.error && (
                  <div
                    className="px-2 text-red-500 dark:text-red-400"
                    style={{ paddingLeft: 4 + (depth + 1) * 12 + 16 }}
                  >
                    {child.error}
                  </div>
                )}
                {child && !child.error && child.entries.length === 0 && !child.loading && (
                  <div
                    className="text-fg-muted"
                    style={{ paddingLeft: 4 + (depth + 1) * 12 + 16 }}
                  >
                    (empty)
                  </div>
                )}
                {child && child.entries.length > 0 && (
                  <DirNode
                    path={entryPath}
                    entries={child.entries}
                    depth={depth + 1}
                    dirs={dirs}
                    expanded={expanded}
                    selected={selected}
                    onToggle={onToggle}
                    onSelect={onSelect}
                    onOpenFile={onOpenFile}
                  />
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function IconButton({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded p-1 text-fg-tertiary hover:bg-surface-1 hover:text-fg-secondary',
        active && 'bg-surface-1 text-fg-secondary',
      )}
    >
      {children}
    </button>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatMtime(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}
