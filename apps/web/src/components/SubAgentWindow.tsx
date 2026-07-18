import { memo, useMemo, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import type { ResultChunkDTO } from '@argus/shared-types';
import { cn } from '../lib/utils';
import { ToolPill } from './ToolPill';

type Props = {
  chunks: ResultChunkDTO[];
};

/** One chronological entry of a sub-agent's nested run: a tool call
 *  (paired with its result), a coalesced run of streamed text (the
 *  sub-agent's preamble narration / response prose), or a thinking
 *  block. `id` doubles as the React key. */
type NestedItem =
  | { kind: 'tool'; id: string; tool: ResultChunkDTO; result?: ResultChunkDTO }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; redacted: boolean };

type SubAgentCall = {
  /** Tool-use id; used as a stable React key, to pair the result, and
   *  to match `meta.parentToolUseId` on nested sub-agent chunks. */
  id: string;
  subagentType: string;
  description: string;
  prompt: string;
  /** Pulled from the matching tool_result chunk if present. */
  result?: string;
  /** True when the paired result chunk arrived as `stderr`. */
  isError: boolean;
  /** Everything the sub-agent did, in chronological order. */
  nested: NestedItem[];
};

/**
 * Per-turn aggregated panel for `Agent` (sub-agent) tool calls.
 *
 * Mirrors the `TodoWindow` shape — a collapsible card rendered above
 * the activity timeline — but with one row per invocation rather
 * than a single latest-replaces-all view, since each sub-agent call
 * is an independent task with its own prompt and reply. Each row
 * lists the nested tool calls the sub-agent made, paired with their
 * tool_result chunks (linked via Claude Code's `parent_tool_use_id`
 * on the parent stream — see ClaudeCode adapter).
 *
 * Returns null when the turn has no `Agent` tool calls. Adapter
 * tool-name matching is restricted to `agent` for now — Claude Code
 * is the only adapter that emits this tool today.
 *
 * memo-wrapped: chunks reference is stabilised by the StreamViewer
 * group layer, so non-live turns won't re-render when a chunk lands
 * on the live one.
 */
export const SubAgentWindow = memo(function SubAgentWindow({ chunks }: Props) {
  const calls = useMemo(() => extractSubAgentCalls(chunks), [chunks]);
  const total = calls.length;
  const [open, setOpen] = useState(true);

  if (total === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg bg-surface-1/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2 px-3.5 py-2 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/40 hover:text-fg-primary"
      >
        <Bot className="h-3.5 w-3.5 shrink-0 text-amber-600/80 dark:text-amber-400/80 group-hover:text-amber-500" />
        <span className="text-fg-secondary">Sub-agents</span>
        <span className="tabular-nums text-fg-tertiary">{total}</span>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform group-hover:text-fg-tertiary',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <ul className="space-y-1.5 px-2 pb-2">
          {calls.map((c) => (
            <SubAgentRow key={c.id} call={c} />
          ))}
        </ul>
      )}
    </div>
  );
});

function toolCount(call: SubAgentCall): number {
  return call.nested.filter((n) => n.kind === 'tool').length;
}

function SubAgentRow({ call }: { call: SubAgentCall }) {
  const hasBody = !!call.prompt || !!call.result || call.nested.length > 0;
  const [open, setOpen] = useState(call.isError);
  return (
    <li className="rounded-md">
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors',
          hasBody ? 'cursor-pointer hover:bg-surface-2/40' : 'cursor-default',
        )}
      >
        {call.subagentType && (
          <span className="rounded bg-surface-2/60 px-1.5 py-px font-mono text-[10px] text-fg-secondary">
            {call.subagentType}
          </span>
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            call.description ? 'text-fg-secondary' : 'text-fg-muted italic',
          )}
        >
          {call.description || 'no description'}
        </span>
        {toolCount(call) > 0 && (
          <span className="tabular-nums text-[10px] text-fg-muted">
            {toolCount(call)} {toolCount(call) === 1 ? 'tool' : 'tools'}
          </span>
        )}
        {call.isError && (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-red-600 dark:text-red-400">
            error
          </span>
        )}
        {hasBody && !call.isError && (
          <ChevronDown
            className={cn(
              'h-3 w-3 shrink-0 text-fg-muted transition-transform',
              open && 'rotate-180',
            )}
          />
        )}
      </button>
      {open && hasBody && (
        <div className="ml-2 mt-1 space-y-2 pb-1">
          {call.prompt && (
            <div>
              <div className="mb-0.5 px-1 text-[10px] uppercase tracking-widest text-fg-muted">
                prompt
              </div>
              <pre className="max-h-48 overflow-auto rounded-md bg-surface-2/40 px-3 py-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap text-fg-tertiary no-scrollbar">
                {call.prompt}
              </pre>
            </div>
          )}
          {call.nested.length > 0 && (
            <div>
              <div className="mb-0.5 px-1 text-[10px] uppercase tracking-widest text-fg-muted">
                activity
              </div>
              <div className="rounded-md bg-surface-2/40 px-1 py-1">
                {call.nested.map((n) =>
                  n.kind === 'tool' ? (
                    <ToolPill key={n.id} tool={n.tool} result={n.result} />
                  ) : n.kind === 'text' ? (
                    <div
                      key={n.id}
                      className="whitespace-pre-wrap px-2 py-1 text-[11px] leading-relaxed text-fg-tertiary"
                    >
                      {n.text}
                    </div>
                  ) : (
                    <div
                      key={n.id}
                      className="whitespace-pre-wrap px-2 py-1 text-[11px] italic leading-relaxed text-fg-muted"
                    >
                      {n.redacted ? '[redacted thinking]' : n.text}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
          {call.result && (
            <div>
              <div className="mb-0.5 px-1 text-[10px] uppercase tracking-widest text-fg-muted">
                {call.isError ? 'error' : 'result'}
              </div>
              <pre
                className={cn(
                  'max-h-48 overflow-auto rounded-md bg-surface-2/40 px-3 py-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap no-scrollbar',
                  call.isError ? 'text-red-600 dark:text-red-400' : 'text-fg-tertiary',
                )}
              >
                {call.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Walk the chunks once, collect every `Agent` tool call, and group
 * each sub-agent's nested tool/result chunks under it via the
 * `parentToolUseId` meta field that the Claude Code adapter
 * surfaces from `parent_tool_use_id` in the stream-json payload.
 *
 * Pairing scheme for tool/result is the same as ActivityPanel uses
 * (`meta.id` ↔ `meta.toolResultFor`); the only addition here is the
 * parent-id filter. Defensive on shape: any input fields we can't
 * read fall back to empty strings rather than dropping the row.
 */
function extractSubAgentCalls(chunks: ResultChunkDTO[]): SubAgentCall[] {
  const resultByToolId = new Map<string, ResultChunkDTO>();
  for (const c of chunks) {
    if (c.kind !== 'stdout' && c.kind !== 'stderr') continue;
    const tid = (c.meta as Record<string, unknown> | null | undefined)?.toolResultFor;
    if (typeof tid === 'string' && tid) resultByToolId.set(tid, c);
  }

  // Collect the sub-agent's nested activity keyed by parent Agent
  // tool_use_id, in chunk-order so the rendered list matches the order
  // Claude streamed it: tool calls, thinking blocks, and streamed text
  // (adjacent nested deltas coalesce into one prose item, mirroring the
  // parent timeline's thought coalescing; a chunk from anything else —
  // top-level or a parallel sibling sub-agent — closes the run).
  const nestedByParent = new Map<string, NestedItem[]>();
  const pushItem = (parentId: string, item: NestedItem) => {
    const list = nestedByParent.get(parentId) ?? [];
    list.push(item);
    nestedByParent.set(parentId, list);
  };
  let textBuf: { parentId: string; firstId: string; texts: string[] } | null = null;
  const flushText = () => {
    if (!textBuf) return;
    const text = textBuf.texts.join('').trim();
    if (text) {
      pushItem(textBuf.parentId, { kind: 'text', id: `text:${textBuf.firstId}`, text });
    }
    textBuf = null;
  };
  for (const c of chunks) {
    const meta = (c.meta ?? {}) as Record<string, unknown>;
    const parentId = typeof meta.parentToolUseId === 'string' ? meta.parentToolUseId : '';
    if (!parentId || (textBuf && textBuf.parentId !== parentId)) flushText();
    if (!parentId) continue;
    if (c.kind === 'delta') {
      if (!textBuf) textBuf = { parentId, firstId: c.id, texts: [] };
      textBuf.texts.push(c.delta ?? '');
      continue;
    }
    flushText();
    if (c.kind === 'tool') {
      const id = typeof meta.id === 'string' && meta.id ? meta.id : c.id;
      pushItem(parentId, { kind: 'tool', id, tool: c, result: resultByToolId.get(id) });
    } else if (c.kind === 'progress' && meta.contentType === 'thinking' && c.content) {
      pushItem(parentId, {
        kind: 'thinking',
        id: `thinking:${c.id}`,
        text: c.content,
        redacted: meta.redacted === true,
      });
    }
  }
  flushText();

  const out: SubAgentCall[] = [];
  for (const c of chunks) {
    if (c.kind !== 'tool') continue;
    const meta = (c.meta ?? {}) as Record<string, unknown>;
    const name = typeof meta.tool === 'string' ? meta.tool.toLowerCase() : '';
    if (name !== 'agent') continue;
    const input = (meta.input ?? {}) as Record<string, unknown>;
    const id = typeof meta.id === 'string' && meta.id ? meta.id : c.id;
    const subagentType =
      (input.subagent_type as string | undefined) ??
      (input.subagentType as string | undefined) ??
      '';
    const description = (input.description as string | undefined) ?? '';
    const prompt = (input.prompt as string | undefined) ?? '';
    const paired = resultByToolId.get(id);
    out.push({
      id,
      subagentType,
      description,
      prompt,
      result: paired?.content?.trim() || undefined,
      isError: paired?.kind === 'stderr',
      nested: nestedByParent.get(id) ?? [],
    });
  }
  return out;
}
