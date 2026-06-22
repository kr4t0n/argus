import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { CommandDTO, ResultChunkDTO } from '@argus/shared-types';
import { DiffBlock } from './ui/DiffBlock';
import { cn } from '../lib/utils';

/** Max rendered height of a single file's diff before it scrolls inside
 *  its own box. A cap (not a literal fixed height) so small diffs stay
 *  short while a huge patch can't dominate the pane. */
const FILE_MAX_HEIGHT = 'max-h-80';

type Props = {
  commands: CommandDTO[];
  chunks: ResultChunkDTO[];
  /** Used to display file paths relative to the project root instead of
   *  the absolute paths the sidecar resolves them to. */
  workingDir?: string | null;
};

type FileGroup = {
  /** Absolute path as captured by the sidecar — the group key + tooltip. */
  rawPath: string;
  /** Display path, made relative to `workingDir` when possible. */
  path: string;
  /** Each edit's unified diff for this file, in turn order. */
  diffs: string[];
  add: number;
  del: number;
  changeKind?: string;
};

/** Count added/removed lines in a unified diff (ignoring the `+++`/`---`
 *  file headers). Cheap string scan — diffs are already capped at 400
 *  lines by the sidecar. */
function countDiff(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}

function relativePath(p: string, workingDir?: string | null): string {
  if (workingDir && p.startsWith(workingDir)) {
    const rest = p.slice(workingDir.length).replace(/^\/+/, '');
    return rest || p;
  }
  return p;
}

/**
 * The "Diff" extension pane: every file the agent changed in the session's
 * most recent turn, grouped by file with per-file +/- counts. It reuses the
 * unified diffs the sidecar already computes per edit (result chunks with
 * `meta.isDiff === true`, `meta.filePath`, `content = <diff>`), so there's
 * no new capture — just aggregation of the last command's diff chunks.
 * Re-derives reactively, so diffs appear live while a turn is still editing.
 */
export function DiffPane({ commands, chunks, workingDir }: Props) {
  const executes = useMemo(() => commands.filter((c) => c.kind === 'execute'), [commands]);

  const groups = useMemo<FileGroup[]>(() => {
    if (executes.length === 0) return [];
    // Most recent turn by createdAt — robust to array ordering.
    const last = executes.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    const byPath = new Map<string, FileGroup>();
    const order: string[] = [];
    for (const c of chunks) {
      if (c.commandId !== last.id) continue;
      const meta = (c.meta ?? {}) as Record<string, unknown>;
      if (meta.isDiff !== true) continue;
      const text = c.content?.trim();
      if (!text) continue;
      const rawPath = (meta.filePath as string | undefined) ?? '(unknown file)';
      const { add, del } = countDiff(text);
      let g = byPath.get(rawPath);
      if (!g) {
        g = {
          rawPath,
          path: relativePath(rawPath, workingDir),
          diffs: [],
          add: 0,
          del: 0,
          changeKind: typeof meta.changeKind === 'string' ? meta.changeKind : undefined,
        };
        byPath.set(rawPath, g);
        order.push(rawPath);
      }
      g.diffs.push(text);
      g.add += add;
      g.del += del;
    }
    return order.map((p) => byPath.get(p)!);
  }, [executes, chunks, workingDir]);

  // Per-file collapse state, keyed by the stable absolute path so it
  // survives the live re-derivation as a turn keeps editing. Files
  // default to expanded (absent from the map); the header toggles them.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (rawPath: string) =>
    setCollapsed((c) => ({ ...c, [rawPath]: !c[rawPath] }));

  if (executes.length === 0) {
    return <p className="pt-2 text-sm text-fg-tertiary">No turns yet.</p>;
  }
  if (groups.length === 0) {
    return <p className="pt-2 text-sm text-fg-tertiary">No file changes in the last turn.</p>;
  }

  return (
    <div className="space-y-4 pb-4">
      {groups.map((g) => {
        const isCollapsed = collapsed[g.rawPath] ?? false;
        return (
          <div key={g.rawPath} className="space-y-1">
            {/* Whole header row toggles the file open/closed. */}
            <button
              type="button"
              onClick={() => toggle(g.rawPath)}
              aria-expanded={!isCollapsed}
              className="group flex w-full items-center gap-2 text-[11px]"
            >
              <ChevronDown
                className={cn(
                  'h-3 w-3 shrink-0 text-fg-muted transition-transform group-hover:text-fg-tertiary',
                  isCollapsed && '-rotate-90',
                )}
              />
              <span
                className="min-w-0 flex-1 truncate text-left font-mono text-fg-secondary"
                title={g.rawPath}
              >
                {g.path}
              </span>
              {g.changeKind && (
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-fg-muted">
                  {g.changeKind}
                </span>
              )}
              <span className="shrink-0 font-mono tabular-nums">
                {g.add > 0 && (
                  <span className="text-emerald-600 dark:text-emerald-400">+{g.add}</span>
                )}
                {g.add > 0 && g.del > 0 && ' '}
                {g.del > 0 && <span className="text-red-600 dark:text-red-400">-{g.del}</span>}
              </span>
            </button>
            {/* Cap each file's diff height and scroll inside it, so one
                huge patch can't push every other file off-screen. The
                DiffBlocks themselves stay uncapped — the wrapper owns the
                height + (visible) scrollbar. */}
            {!isCollapsed && (
              <div className={cn(FILE_MAX_HEIGHT, 'space-y-1 overflow-y-auto')}>
                {g.diffs.map((d, i) => (
                  <DiffBlock key={i} text={d} maxHeightClass="" />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
