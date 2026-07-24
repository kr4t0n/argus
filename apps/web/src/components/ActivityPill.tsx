import { useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';
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
  // Tools that have their own dedicated panel above the timeline
  // (TodoWindow, SubAgentWindow) are excluded from the capsule too —
  // the count and "last tool" summary should mirror what's actually
  // rendered below the capsule, not what's been factored out.
  const tools = chunks.filter(
    (c) => c.kind === 'tool' && !isNestedSubAgentChunk(c) && !isDedicatedPanelTool(c),
  );
  // `running` is the live flag: while the turn runs, the trailing deltas
  // fold in as thoughts so `items` reflects what the expanded panel shows.
  const items: TimelineItem[] = useMemo(() => buildTimeline(chunks, running), [chunks, running]);

  // Re-render on a 100 ms tick while the turn is live so the elapsed-time
  // readout advances smoothly instead of jumping whenever a chunk arrives.
  // Gated on `running` — once the turn finishes, `endedAt` freezes the
  // value and no further ticks are needed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  if (items.length === 0 && !running) return null;

  const elapsedMs = (endedAt ?? now) - startedAt;
  const elapsed = formatElapsed(elapsedMs);
  const lastTool = tools[tools.length - 1];

  return (
    <button
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-3 rounded-full bg-surface-1/60 px-3.5 py-1.5 text-xs text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary transition-colors',
        open && 'bg-surface-2/60 text-fg-primary',
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
          <span className="truncate max-w-[180px] font-mono text-fg-tertiary">
            {lastTool ? summarizeTool(lastTool) : 'done'}
          </span>
        )}
      </span>
      <Sep />
      <span className="tabular-nums text-fg-tertiary">{elapsed}</span>
      <ChevronDown
        className={cn('h-3 w-3 text-fg-tertiary transition-transform', open && 'rotate-180')}
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
export function ActivityPanel({
  chunks,
  live = false,
}: {
  chunks: ResultChunkDTO[];
  /** While true, the turn's trailing deltas are folded in as live
   *  thoughts instead of being left to the StreamViewer body. */
  live?: boolean;
}) {
  const items: TimelineItem[] = useMemo(() => buildTimeline(chunks, live), [chunks, live]);
  if (items.length === 0) return null;
  return (
    <div className="ml-1 space-y-1.5 border-l border-default/60 pl-4">
      {items.map((it) => {
        if (it.kind === 'tool') {
          return <ToolPill key={it.tool.id} tool={it.tool} result={it.result} />;
        }
        if (it.kind === 'output') {
          const c = it.chunk;
          return (
            <pre
              key={c.id}
              className="overflow-x-auto rounded-md bg-surface-1/50 px-3 py-2 text-[11px] font-mono whitespace-pre-wrap leading-relaxed no-scrollbar"
            >
              <span className={c.kind === 'stderr' ? 'text-red-500 dark:text-red-400' : 'text-fg-tertiary'}>
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
              className="markdown max-w-none py-1.5 text-xs leading-relaxed text-fg-tertiary"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
            </div>
          );
        }
        if (it.kind === 'thinking') {
          // Extended-thinking reasoning block (claude-code `thinking`
          // content). Distinguished from a plain 'thought' by a small
          // "Thinking" caption + brain glyph, and rendered most subdued of
          // all since it's private reasoning, not part of the answer.
          return (
            <div key={it.id} className="py-1.5 text-xs leading-relaxed">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-fg-tertiary/70">
                <Brain className="h-3 w-3" />
                Thinking
              </div>
              {it.redacted ? (
                <span className="text-xs italic text-fg-tertiary/70">[redacted]</span>
              ) : (
                <div className="markdown max-w-none text-fg-tertiary/80">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
                </div>
              )}
            </div>
          );
        }
        if (it.kind === 'compact') {
          // Compaction divider (manual /compact or threshold auto): the
          // CLI replaced everything above with a summary — mark the seam.
          return (
            <div key={it.id} className="flex items-center gap-2 py-1.5">
              <div className="h-px flex-1 bg-fg-muted/25" />
              <span className="text-[10px] uppercase tracking-widest text-fg-muted">
                {it.label}
              </span>
              <div className="h-px flex-1 bg-fg-muted/25" />
            </div>
          );
        }
        if (it.kind === 'compact-summary') {
          // What future turns actually know about the compacted past —
          // collapsed by default (long, and semi-internal CLI copy).
          return (
            <details key={it.id} className="py-1">
              <summary className="cursor-pointer list-none text-[10px] uppercase tracking-widest text-fg-muted hover:text-fg-tertiary">
                compaction summary
              </summary>
              <div className="markdown max-w-none py-1.5 text-xs leading-relaxed text-fg-tertiary">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
              </div>
            </details>
          );
        }
        return (
          <div key={it.chunk.id} className="text-xs text-fg-tertiary italic">
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
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; redacted: boolean }
  | { kind: 'compact'; id: string; label: string }
  | { kind: 'compact-summary'; id: string; text: string };

/**
 * Pair every `tool` chunk with its matching `stdout` / `stderr` result
 * (matched by tool_use_id), so the renderer can show them as a single
 * Cursor-style card. Anything left over (free-floating output / progress)
 * is preserved in chronological order. Intermediate `delta` chunks (any
 * delta whose seq is at-or-before the last tool/output chunk) become
 * 'thought' items here; deltas after the last tool are the final
 * assistant answer and are intentionally NOT in the timeline — the
 * StreamViewer body renders those as the message proper.
 *
 * `live` flips that last rule while a turn is still running: the trailing
 * deltas can't be classified yet (they become preamble if a tool follows,
 * or the answer if the turn ends), so we fold them in as thoughts too and
 * the body stays empty until the turn settles. This keeps streaming text
 * from ever rendering as a standalone block that flashes and relocates
 * when the next tool lands. Once the turn is done, `live` is false again
 * and the trailing deltas drop out of the timeline into the body.
 */
function buildTimeline(chunks: ResultChunkDTO[], live = false): TimelineItem[] {
  const { boundarySeq } = splitDeltas(chunks);

  const resultByToolId = new Map<string, ResultChunkDTO>();
  const consumed = new Set<string>();
  for (const c of chunks) {
    if (c.kind !== 'stdout' && c.kind !== 'stderr') continue;
    // Sub-agent tool_results are scoped to the SubAgentWindow row —
    // exclude them from the parent timeline's pairing index too, or
    // they'd surface as orphaned output rows for tools the timeline
    // intentionally hid.
    if (isNestedSubAgentChunk(c)) continue;
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
      // Nested sub-agent text (preamble narration + streamed response)
      // renders inside its SubAgentWindow row, like nested tools.
      if (isNestedSubAgentChunk(c)) continue;
      // Settled: trailing (post-tool) deltas are the final answer, owned
      // by the StreamViewer body. Live: fold them in here as a thought.
      if (!live && c.seq > boundarySeq) continue;
      if (!buf) buf = { ids: [], texts: [] };
      buf.ids.push(c.id);
      buf.texts.push(c.delta ?? '');
      continue;
    }
    if (c.kind === 'tool') {
      // Nested sub-agent tool calls render under their parent Agent
      // row in <SubAgentWindow>. Skip here so we don't double-render.
      if (isNestedSubAgentChunk(c)) continue;
      // Tools with dedicated panels above the timeline (TodoWrite →
      // TodoWindow, Agent → SubAgentWindow) are also intentionally
      // hidden — but we still mark their paired tool_result as
      // consumed so it doesn't surface as an orphaned output row.
      if (isDedicatedPanelTool(c)) {
        const id = (c.meta as Record<string, unknown> | null | undefined)?.id;
        if (typeof id === 'string') {
          const result = resultByToolId.get(id);
          if (result) consumed.add(result.id);
        }
        continue;
      }
      flushThought();
      const id = (c.meta as Record<string, unknown> | null | undefined)?.id;
      const result = typeof id === 'string' ? resultByToolId.get(id) : undefined;
      if (result) consumed.add(result.id);
      out.push({ kind: 'tool', tool: c, result });
      continue;
    }
    if (c.kind === 'stdout' || c.kind === 'stderr') {
      if (isNestedSubAgentChunk(c)) continue;
      flushThought();
      if (consumed.has(c.id)) continue;
      out.push({ kind: 'output', chunk: c });
      continue;
    }
    // Drop content-less progress chunks — the claude-code sidecar emits
    // these for meta events (e.g. unknown stream-json types) that carry
    // no user-visible signal; rendering them as "working…" rows just
    // clutters the timeline. Also drop Claude's `task_started` /
    // `task_progress` narration: those describe a sub-agent action
    // (e.g. "Running Print working directory") and the actual nested
    // tool call already shows up in the SubAgentWindow row, so the
    // narration is just duplicate noise in the parent timeline.
    if (c.kind === 'progress' && c.content) {
      const meta = (c.meta ?? {}) as Record<string, unknown>;
      // Extended-thinking reasoning block from the claude-code sidecar
      // (contentType=thinking). Render as its own labelled 'thinking' row
      // rather than the generic progress fallback. Nested sub-agent
      // thinking is scoped to its SubAgentWindow, so skip it here the same
      // way nested tool/output chunks are. (The companion `thinking_tokens`
      // chunk is content-less and never reaches this branch.)
      if (meta.contentType === 'thinking') {
        if (isNestedSubAgentChunk(c)) continue;
        flushThought();
        out.push({
          kind: 'thinking',
          id: `thinking:${c.id}`,
          text: c.content,
          redacted: meta.redacted === true,
        });
        continue;
      }
      if (meta.contentType === 'compact_boundary') {
        flushThought();
        out.push({ kind: 'compact', id: `compact:${c.id}`, label: c.content });
        continue;
      }
      if (meta.contentType === 'compact_summary') {
        flushThought();
        out.push({ kind: 'compact-summary', id: `compact-summary:${c.id}`, text: c.content });
        continue;
      }
      if (typeof meta.tool_use_id === 'string' && meta.tool_use_id) continue;
      flushThought();
      out.push({ kind: 'progress', chunk: c });
    }
  }
  flushThought();
  return out;
}

/**
 * True when a chunk belongs to a sub-agent dispatch — the Claude Code
 * adapter sets `parentToolUseId` on every tool/result chunk emitted
 * inside an Agent (Task) tool's nested run. SubAgentWindow groups
 * those chunks under their parent Agent row, so the parent timeline
 * intentionally excludes them.
 */
function isNestedSubAgentChunk(c: ResultChunkDTO): boolean {
  const meta = (c.meta ?? {}) as Record<string, unknown>;
  const pid = meta.parentToolUseId;
  return typeof pid === 'string' && pid.length > 0;
}

/**
 * True when a tool chunk is one we render in a dedicated turn-level
 * panel above the activity timeline — keep this matcher in sync with
 * TodoWindow's `extractLatestTodos` and SubAgentWindow's
 * `extractSubAgentCalls`. The activity timeline hides these so we
 * don't double-render the same call (once in the panel + once as a
 * timeline row).
 */
function isDedicatedPanelTool(c: ResultChunkDTO): boolean {
  const meta = (c.meta ?? {}) as Record<string, unknown>;
  const name = typeof meta.tool === 'string' ? meta.tool.toLowerCase() : '';
  return (
    name === 'agent' ||
    name === 'todowrite' ||
    name === 'todo' ||
    name === 'task' ||
    name === 'updatetodos' ||
    // Claude Code ≥ 2.1.x incremental task tools. The sidecar follows each
    // result with a synthesized TodoWrite snapshot that drives TodoWindow,
    // so the raw calls would only duplicate it in the timeline.
    name === 'taskcreate' ||
    name === 'taskupdate' ||
    name === 'tasklist' ||
    name === 'taskget'
  );
}

function Sep() {
  return <span className="text-fg-muted">·</span>;
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1 w-1 rounded-full bg-fg-tertiary animate-pulse"
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
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.round(s - mins * 60);
  return `${mins}m ${secs}s`;
}
