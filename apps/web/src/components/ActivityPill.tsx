import { useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ResultChunkDTO } from '@argus/shared-types';
import { cn } from '../lib/utils';
import { splitDeltas } from '../lib/deltaSplit';
import { ToolPill } from './ToolPill';

type Props = {
  chunks: ResultChunkDTO[];
  running: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Whether the timeline panel is expanded. Controlled by the parent so
   *  the parent can render the capsule (this component) inside a sticky
   *  header band while rendering the panel separately, below the band. */
  open: boolean;
  onToggle: () => void;
};

/**
 * Compact summary capsule for everything the agent did between user prompt
 * and final answer: tool count + elapsed time, plus a chevron that flips
 * the parent-controlled `open` state.
 *
 * The capsule is intentionally *just* the button — the expanded timeline
 * lives in `<ActivityPanel>` so the capsule can stay pinned to the top of
 * the viewport while the panel scrolls naturally with the rest of the
 * turn's content.
 *
 * Inspired by the activity pill in vercel-labs/open-agents.
 */
export function ActivityPill({ chunks, running, startedAt, endedAt, open, onToggle }: Props) {
  const tools = chunks.filter((c) => c.kind === 'tool');
  const items: TimelineItem[] = useMemo(() => buildTimeline(chunks), [chunks]);
  if (items.length === 0 && !running) return null;

  const elapsedMs = (endedAt ?? Date.now()) - startedAt;
  const elapsed = formatElapsed(elapsedMs);
  const lastTool = tools[tools.length - 1];

  return (
    <button
      onClick={onToggle}
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
  );
}

/**
 * Expanded timeline that lists every tool + output + intermediate
 * "thought" delta in chronological order. Rendered as a separate
 * component (rather than a child of `<ActivityPill>`) so the parent can
 * pin the capsule via `position: sticky` while letting the panel scroll
 * normally with the rest of the turn — pinning the panel too would
 * defeat the purpose since a long timeline is usually taller than the
 * viewport itself.
 */
export function ActivityPanel({ chunks }: { chunks: ResultChunkDTO[] }) {
  const items: TimelineItem[] = useMemo(() => buildTimeline(chunks), [chunks]);
  if (items.length === 0) return null;
  return (
    <div className="ml-1 space-y-2 border-l border-neutral-800/80 pl-4">
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
        if (it.kind === 'thought') {
          // Intermediate assistant text — model "thinking out loud" in
          // between tool calls. Rendered with markdown so code blocks
          // and lists stay legible, but with subdued color so the eye
          // routes to the final answer below the activity capsule.
          return (
            <div
              key={it.id}
              className="markdown text-xs leading-relaxed text-neutral-400 max-w-none"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
            </div>
          );
        }
        return (
          <div key={it.chunk.id} className="text-xs text-neutral-500 italic">
            {it.chunk.content ?? 'working…'}
          </div>
        );
      })}
    </div>
  );
}

type TimelineItem =
  | { kind: 'tool'; tool: ResultChunkDTO; result?: ResultChunkDTO }
  | { kind: 'output'; chunk: ResultChunkDTO }
  | { kind: 'progress'; chunk: ResultChunkDTO }
  | { kind: 'thought'; id: string; text: string };

/**
 * Pair every `tool` chunk with its matching `stdout` / `stderr` result
 * (matched by tool_use_id), so the renderer can show them as a single
 * Cursor-style card. Anything left over (free-floating output / progress)
 * is preserved in chronological order. Intermediate `delta` chunks (any
 * delta whose seq is at-or-before the last tool/output chunk) become
 * 'thought' items here; deltas after the last tool are the final
 * assistant answer and are intentionally NOT in the timeline — the
 * StreamViewer body renders those as the message proper.
 */
function buildTimeline(chunks: ResultChunkDTO[]): TimelineItem[] {
  const { boundarySeq } = splitDeltas(chunks);

  const resultByToolId = new Map<string, ResultChunkDTO>();
  const consumed = new Set<string>();
  for (const c of chunks) {
    if (c.kind !== 'stdout' && c.kind !== 'stderr') continue;
    const tid = (c.meta as Record<string, unknown> | null | undefined)?.toolResultFor;
    if (typeof tid === 'string' && tid) resultByToolId.set(tid, c);
  }

  const out: TimelineItem[] = [];
  // Pending thought accumulator — adjacent intermediate deltas (no tool
  // separating them) belong to the same conceptual model utterance, so we
  // coalesce them into a single 'thought' item rather than rendering each
  // as its own bubble. Flushed whenever a non-delta chunk comes in.
  let buf: { ids: string[]; texts: string[] } | null = null;
  const flushThought = () => {
    if (!buf) return;
    out.push({ kind: 'thought', id: `thought:${buf.ids[0]}`, text: buf.texts.join('') });
    buf = null;
  };

  for (const c of chunks) {
    if (c.kind === 'delta') {
      if (c.seq > boundarySeq) continue; // final answer, rendered by StreamViewer body
      if (!buf) buf = { ids: [], texts: [] };
      buf.ids.push(c.id);
      buf.texts.push(c.delta ?? '');
      continue;
    }
    if (c.kind === 'tool') {
      flushThought();
      const id = (c.meta as Record<string, unknown> | null | undefined)?.id;
      const result = typeof id === 'string' ? resultByToolId.get(id) : undefined;
      if (result) consumed.add(result.id);
      out.push({ kind: 'tool', tool: c, result });
      continue;
    }
    if (c.kind === 'stdout' || c.kind === 'stderr') {
      flushThought();
      if (consumed.has(c.id)) continue;
      out.push({ kind: 'output', chunk: c });
      continue;
    }
    if (c.kind === 'progress') {
      flushThought();
      out.push({ kind: 'progress', chunk: c });
    }
  }
  flushThought();
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
