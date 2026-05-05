import { memo, useState } from 'react';
import {
  ChevronDown,
  FileText,
  FileCode2,
  FilePlus2,
  Trash2,
  ArrowRightLeft,
  Pencil,
  Search,
  FolderSearch,
  Terminal,
  ListTree,
  Globe,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ResultChunkDTO } from '@argus/shared-types';
import { cn } from '../lib/utils';

type Props = {
  tool: ResultChunkDTO;
  result?: ResultChunkDTO;
};

/**
 * Cursor-style tool card: a single bordered box where the header row shows
 * `[icon] <verb> [chip arg]` and the body shows the tool's output. A chevron
 * on the header toggles the raw input JSON for transparency.
 *
 * memo-wrapped: the `tool` and `result` chunks are reused by reference
 * across renders from the StreamViewer group-stabilization layer, so
 * default shallow equality suffices to skip re-renders for unchanged
 * tool cards while new chunks land on the live turn.
 */
export const ToolPill = memo(function ToolPill({ tool, result }: Props) {
  const [openArgs, setOpenArgs] = useState(false);
  const meta = (tool.meta ?? {}) as Record<string, unknown>;
  const name = (meta.tool as string | undefined) ?? extractToolName(tool.content ?? '');
  const input = (meta.input ?? {}) as Record<string, unknown>;
  const Icon = iconFor(name);
  const iconColor = iconColorFor(name);
  const { verb, arg, mono } = describe(name, input, tool.content ?? '');
  const hasInputDetail = Object.keys(input).length > 0;
  const isError = result?.kind === 'stderr';
  const resultText = result?.content?.trim();
  const resultMeta = (result?.meta ?? {}) as Record<string, unknown>;
  const isDiff = resultMeta.isDiff === true;

  const [openBody, setOpenBody] = useState(isError);
  const hasBody = !!resultText;
  const expandable = hasInputDetail || hasBody;

  return (
    <div className="group/tool my-px">
      <button
        onClick={() => expandable && setOpenBody((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors',
          expandable ? 'cursor-pointer hover:bg-surface-1/60' : 'cursor-default',
        )}
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
        <span className="text-fg-tertiary">{verb}</span>
        {arg && (
          <span
            className={cn(
              'truncate text-fg-muted',
              mono && 'font-mono text-[11px]',
            )}
          >
            {arg}
          </span>
        )}
        {isError && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-red-600 dark:text-red-400">
            error
          </span>
        )}
        {expandable && !isError && (
          <ChevronDown
            className={cn(
              'ml-auto h-3 w-3 shrink-0 text-fg-muted transition-transform',
              openBody && 'rotate-180',
            )}
          />
        )}
      </button>

      {openBody && (
        <div className="mb-1 ml-[22px] mt-1 space-y-1">
          {hasInputDetail && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpenArgs((o) => !o);
              }}
              className="text-[10px] uppercase tracking-widest text-fg-muted hover:text-fg-tertiary"
            >
              {openArgs ? 'hide input' : 'show input'}
            </button>
          )}
          {openArgs && hasInputDetail && (
            <pre className="rounded-md bg-surface-1/50 px-3 py-2 text-[11px] font-mono leading-relaxed text-fg-tertiary overflow-x-auto no-scrollbar">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
          {hasBody &&
            (isDiff ? (
              <DiffBlock text={resultText!} />
            ) : (
              <pre
                className={cn(
                  'max-h-36 overflow-auto rounded-md bg-surface-1/50 px-3 py-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap no-scrollbar',
                  isError ? 'text-red-600 dark:text-red-400' : 'text-fg-tertiary',
                )}
              >
                {resultText}
              </pre>
            ))}
        </div>
      )}
    </div>
  );
});

/**
 * Renders a unified diff with per-line colors (green adds / red removes /
 * neutral context) plus a collapsed hunk header. We skip the `--- a/...` and
 * `+++ b/...` file headers because the ToolPill's own header already names
 * the file — showing them again is noise.
 */
function DiffBlock({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="max-h-36 overflow-auto rounded-md bg-surface-1/50 px-0 py-1 text-[11px] font-mono leading-relaxed no-scrollbar">
      {lines.map((line, i) => {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) return null;
        // Per-line colors are paired light/dark: light needs darker
        // foregrounds + a higher-opacity background to keep
        // contrast against the white page; dark inherits the
        // original (lighter foregrounds, near-transparent bg).
        let cls = 'text-fg-tertiary';
        let bg = '';
        if (line.startsWith('@@')) {
          cls = 'text-violet-700 dark:text-violet-400';
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          cls = 'text-emerald-700 dark:text-emerald-300';
          bg = 'bg-emerald-500/10 dark:bg-emerald-500/5';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          cls = 'text-red-700 dark:text-red-400';
          bg = 'bg-red-500/10 dark:bg-red-500/5';
        } else if (line.startsWith('…')) {
          cls = 'text-fg-tertiary italic';
        }
        return (
          <div key={i} className={cn('px-3 whitespace-pre-wrap break-all', cls, bg)}>
            {line || '\u00A0'}
          </div>
        );
      })}
    </div>
  );
}

function extractToolName(s: string): string {
  return s.split(' ')[0] || 'tool';
}

type Described = { verb: string; arg: string; mono: boolean };

function describe(name: string, input: Record<string, unknown>, fallback: string): Described {
  const n = name.toLowerCase();

  const file =
    (input.file_path as string | undefined) ??
    (input.filePath as string | undefined) ??
    (input.path as string | undefined) ??
    (input.filename as string | undefined);

  const pattern = (input.pattern as string | undefined) ?? (input.glob as string | undefined);
  const query = (input.query as string | undefined) ?? (input.search as string | undefined);
  const cmd = (input.command as string | undefined) ?? (input.cmd as string | undefined);
  const url = input.url as string | undefined;

  if ((n === 'read' || n === 'cat' || n === 'open') && file)
    return { verb: 'Read', arg: file, mono: true };
  if ((n === 'write' || n === 'create') && file)
    return { verb: 'Wrote', arg: file, mono: true };
  if ((n === 'edit' || n === 'patch' || n === 'multiedit') && file)
    return { verb: 'Edited', arg: file, mono: true };
  if ((n === 'delete' || n === 'remove' || n === 'rm') && file)
    return { verb: 'Deleted', arg: file, mono: true };
  if ((n === 'rename' || n === 'move' || n === 'mv') && file)
    return { verb: 'Renamed', arg: file, mono: true };
  if (n === 'grep' && (pattern || query))
    return { verb: 'Searched codebase for', arg: pattern ?? query!, mono: false };
  if ((n === 'glob' || n === 'find' || n === 'ls') && (pattern || file))
    return { verb: 'Listed', arg: (pattern ?? file)!, mono: true };
  if ((n === 'bash' || n === 'shell' || n === 'exec' || n === 'run') && cmd)
    return { verb: 'Ran', arg: cmd, mono: true };
  if ((n === 'fetch' || n === 'webfetch') && url)
    return { verb: 'Fetched', arg: url, mono: true };
  if (n === 'websearch' && query)
    return { verb: 'Searched web for', arg: query, mono: false };
  if (n === 'task' || n === 'todo' || n === 'todowrite')
    return { verb: 'Updated todos', arg: '', mono: false };

  const arg = file ?? pattern ?? query ?? cmd ?? url ?? stripPrefix(fallback, name);
  return { verb: name || 'Called tool', arg: arg ?? '', mono: true };
}

function stripPrefix(s: string, prefix: string): string {
  return s.replace(new RegExp(`^${prefix}\\s*`, 'i'), '').trim();
}

function iconFor(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n === 'read' || n === 'cat' || n === 'open') return FileText;
  if (n === 'write' || n === 'create') return FilePlus2;
  if (n === 'edit' || n === 'patch' || n === 'multiedit') return Pencil;
  if (n === 'delete' || n === 'remove' || n === 'rm') return Trash2;
  if (n === 'rename' || n === 'move' || n === 'mv') return ArrowRightLeft;
  if (n === 'grep' || n === 'search') return Search;
  if (n === 'glob' || n === 'find' || n === 'ls') return FolderSearch;
  if (n === 'bash' || n === 'shell' || n === 'exec' || n === 'run') return Terminal;
  if (n === 'task' || n === 'todo' || n === 'todowrite') return ListTree;
  if (n === 'fetch' || n === 'webfetch' || n === 'websearch') return Globe;
  if (n === 'codebase' || n === 'symbols') return FileCode2;
  return Wrench;
}

function iconColorFor(name: string): string {
  const n = name.toLowerCase();
  if (n === 'read' || n === 'cat' || n === 'open' || n === 'codebase' || n === 'symbols')
    return 'text-blue-600/70 dark:text-blue-400/70';
  if (
    n === 'write' ||
    n === 'create' ||
    n === 'edit' ||
    n === 'patch' ||
    n === 'multiedit' ||
    n === 'rename' ||
    n === 'move' ||
    n === 'mv'
  )
    return 'text-violet-600/70 dark:text-violet-400/70';
  if (n === 'delete' || n === 'remove' || n === 'rm')
    return 'text-rose-600/70 dark:text-rose-400/70';
  if (n === 'grep' || n === 'search' || n === 'glob' || n === 'find' || n === 'ls')
    return 'text-teal-600/70 dark:text-teal-400/70';
  if (n === 'bash' || n === 'shell' || n === 'exec' || n === 'run')
    return 'text-emerald-600/70 dark:text-emerald-400/70';
  if (n === 'task' || n === 'todo' || n === 'todowrite')
    return 'text-orange-600/70 dark:text-orange-400/70';
  if (n === 'fetch' || n === 'webfetch' || n === 'websearch')
    return 'text-indigo-600/70 dark:text-indigo-400/70';
  return 'text-fg-muted';
}
