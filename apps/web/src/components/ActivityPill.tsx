import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ResultChunkDTO } from '@argus/shared-types';
import { cn } from '../lib/utils';
import { ToolPill } from './ToolPill';

type Props = {
  chunks: ResultChunkDTO[];
  running: boolean;
  startedAt: number;
  endedAt: number | null;
};

/**
 * Compact summary capsule for everything the agent did between user prompt
 * and final answer: tool count + elapsed time, with a click-to-expand panel
 * that shows the original chronological tool / stdout / progress trace.
 *
 * Inspired by the activity pill in vercel-labs/open-agents.
 */
export function ActivityPill({ chunks, running, startedAt, endedAt }: Props) {
  const [open, setOpen] = useState(false);
  const tools = chunks.filter((c) => c.kind === 'tool');
  const items: TimelineItem[] = useMemo(() => buildTimeline(chunks), [chunks]);
  if (items.length === 0 && !running) return null;

  const elapsedMs = (endedAt ?? Date.now()) - startedAt;
  const elapsed = formatElapsed(elapsedMs);
  const lastTool = tools[tools.length - 1];

  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-3 rounded-full border border-neutral-800 bg-neutral-900/60 px-3.5 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200 transition-colors',
          open && 'bg-neutral-800/60 text-neutral-200',
        )}
      >
        <span className="tabular-nums">
          {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
        </span>
        <Sep />
        <span className="flex items-center gap-1.5">
          {running ? (
            <span className="flex gap-1">
              <Dot delay="0ms" />
              <Dot delay="160ms" />
              <Dot delay="320ms" />
            </span>
          ) : (
            <span className="truncate max-w-[180px] font-mono text-neutral-500">
              {lastTool ? summarizeTool(lastTool) : 'done'}
            </span>
          )}
        </span>
        <Sep />
        <span className="tabular-nums text-neutral-500">{elapsed}</span>
        <ChevronDown
          className={cn('h-3 w-3 text-neutral-500 transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="ml-1 space-y-1.5 border-l border-neutral-800/80 pl-4">
          {items.map((it) => {
            if (it.kind === 'tool') {
              return <ToolPill key={it.tool.id} tool={it.tool} result={it.result} />;
            }
            if (it.kind === 'output') {
              const c = it.chunk;
              return (
                <pre
                  key={c.id}
                  className="overflow-x-auto rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-xs font-mono whitespace-pre-wrap leading-relaxed"
                >
                  <span className={c.kind === 'stderr' ? 'text-red-400' : 'text-neutral-400'}>
                    {c.content}
                  </span>
                </pre>
              );
            }
            return (
              <div key={it.chunk.id} className="text-xs text-neutral-500 italic">
                {it.chunk.content ?? 'working…'}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type TimelineItem =
  | { kind: 'tool'; tool: ResultChunkDTO; result?: ResultChunkDTO }
  | { kind: 'output'; chunk: ResultChunkDTO }
  | { kind: 'progress'; chunk: ResultChunkDTO };

/**
 * Pair every `tool` chunk with its matching `stdout` / `stderr` result
 * (matched by tool_use_id), so the renderer can show them as a single
 * Cursor-style card. Anything left over (free-floating output / progress)
 * is preserved in chronological order.
 */
function buildTimeline(chunks: ResultChunkDTO[]): TimelineItem[] {
  const resultByToolId = new Map<string, ResultChunkDTO>();
  const consumed = new Set<string>();
  for (const c of chunks) {
    if (c.kind !== 'stdout' && c.kind !== 'stderr') continue;
    const tid = (c.meta as Record<string, unknown> | null | undefined)?.toolResultFor;
    if (typeof tid === 'string' && tid) resultByToolId.set(tid, c);
  }

  const out: TimelineItem[] = [];
  for (const c of chunks) {
    if (c.kind === 'tool') {
      const id = (c.meta as Record<string, unknown> | null | undefined)?.id;
      const result = typeof id === 'string' ? resultByToolId.get(id) : undefined;
      if (result) consumed.add(result.id);
      out.push({ kind: 'tool', tool: c, result });
      continue;
    }
    if (c.kind === 'stdout' || c.kind === 'stderr') {
      if (consumed.has(c.id)) continue;
      out.push({ kind: 'output', chunk: c });
      continue;
    }
    if (c.kind === 'progress') {
      out.push({ kind: 'progress', chunk: c });
    }
  }
  return out;
}

function Sep() {
  return <span className="text-neutral-700">·</span>;
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1 w-1 rounded-full bg-neutral-400 animate-pulse"
      style={{ animationDelay: delay, animationDuration: '900ms' }}
    />
  );
}

function summarizeTool(c: ResultChunkDTO): string {
  const meta = (c.meta ?? {}) as Record<string, unknown>;
  const tool = (meta.tool as string | undefined) ?? '';
  const input = (meta.input ?? {}) as Record<string, unknown>;
  const fp = input.file_path ?? input.path ?? input.pattern ?? input.command;
  if (typeof fp === 'string' && fp) return `${tool} ${fp}`;
  return tool || (c.content ?? '');
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.round(s - mins * 60);
  return `${mins}m ${secs}s`;
}
