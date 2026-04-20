import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle } from 'lucide-react';
import type { CommandDTO, ResultChunkDTO } from '@argus/shared-types';
import { splitDeltas } from '../lib/deltaSplit';
import { ActivityPill } from './ActivityPill';
import { FileChips, extractFiles } from './FileChips';

type Props = {
  commands: CommandDTO[];
  chunks: ResultChunkDTO[];
  running: boolean;
  /** Anchor used to relativize file chip paths (`AgentDTO.workingDir`). */
  workingDir?: string | null;
};

/**
 * Open-Agents-style chronological feed:
 *   • user prompt as a right-aligned dark pill
 *   • a single "activity" capsule summarising tools + elapsed time (expandable)
 *   • the assistant message as plain markdown body
 *   • file chips for files the agent touched
 *   • errors surfaced inline.
 */
export function StreamViewer({ commands, chunks, running, workingDir }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);

  const grouped = useMemo(() => groupByCommand(commands, chunks), [commands, chunks]);

  useEffect(() => {
    if (!stickBottom) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks.length, stickBottom]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setStickBottom(nearBottom);
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-full overflow-y-auto px-6 py-6"
    >
      <div className="mx-auto max-w-3xl space-y-8">
        {grouped.length === 0 && (
          <div className="flex h-full items-center justify-center pt-32 text-sm text-neutral-500">
            Send a prompt to start the conversation.
          </div>
        )}
        {grouped.map((g) => (
          <CommandBlock
            key={g.command.id}
            command={g.command}
            chunks={g.chunks}
            running={running && isLast(g, grouped)}
            workingDir={workingDir}
          />
        ))}
      </div>
    </div>
  );
}

function isLast<T>(x: T, arr: T[]) {
  return arr[arr.length - 1] === x;
}

function groupByCommand(commands: CommandDTO[], chunks: ResultChunkDTO[]) {
  const map = new Map<string, { command: CommandDTO; chunks: ResultChunkDTO[] }>();
  for (const c of commands) map.set(c.id, { command: c, chunks: [] });
  for (const ch of chunks) {
    let entry = map.get(ch.commandId);
    if (!entry) {
      const stub: CommandDTO = {
        id: ch.commandId,
        sessionId: ch.sessionId,
        agentId: ch.agentId,
        kind: 'execute',
        prompt: null,
        status: 'running',
        createdAt: new Date(ch.ts).toISOString(),
        completedAt: null,
      };
      entry = { command: stub, chunks: [] };
      map.set(ch.commandId, entry);
    }
    entry.chunks.push(ch);
  }
  const out = [...map.values()];
  out.sort((a, b) => a.command.createdAt.localeCompare(b.command.createdAt));
  for (const g of out) g.chunks.sort((a, b) => a.seq - b.seq);
  return out;
}

function CommandBlock({
  command,
  chunks,
  running,
  workingDir,
}: {
  command: CommandDTO;
  chunks: ResultChunkDTO[];
  running: boolean;
  workingDir?: string | null;
}) {
  // Only deltas AFTER the last tool/output chunk count as the user-facing
  // answer — earlier deltas are "thinking" the model emitted between tool
  // calls and are rendered inline by ActivityPill instead. See
  // `lib/deltaSplit.ts` for the full rationale; this lets adapters that
  // emit one assistant text per reasoning step (cursor-cli, claude-code)
  // surface a clean final answer instead of a glued-together transcript.
  const finalDeltaText = useMemo(() => {
    const { finalDeltas } = splitDeltas(chunks);
    return finalDeltas.map((c) => c.delta ?? '').join('');
  }, [chunks]);
  const finalChunk = chunks.find((c) => c.kind === 'final');
  const errorChunk = chunks.find((c) => c.kind === 'error');
  const files = useMemo(() => extractFiles(chunks), [chunks]);

  // Fall back to `final.content` only when no post-tool deltas exist at
  // all — covers adapters that publish a single result event with no
  // streamed deltas, plus the (rare) case of a turn that ended on a tool
  // call with no closing assistant message.
  const bodyText = finalDeltaText || finalChunk?.content?.trim() || '';

  const startedAt = new Date(command.createdAt).getTime();
  const endedAt = command.completedAt ? new Date(command.completedAt).getTime() : null;

  return (
    <div className="space-y-4">
      {command.prompt && <UserMessage text={command.prompt} />}

      <ActivityPill
        chunks={chunks}
        running={running && !finalChunk && !errorChunk}
        startedAt={startedAt}
        endedAt={endedAt}
      />

      {bodyText && (
        <div className="markdown text-sm leading-relaxed text-neutral-200 max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{bodyText}</ReactMarkdown>
          {running && !finalChunk && !errorChunk && (
            <span className="typewriter-cursor" />
          )}
        </div>
      )}

      <FileChips files={files} workingDir={workingDir} />

      {errorChunk && (
        <div className="flex items-start gap-2.5 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
          <pre className="text-xs font-mono text-red-300 whitespace-pre-wrap">
            {errorChunk.content ?? 'error'}
          </pre>
        </div>
      )}
    </div>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl bg-neutral-800/80 px-4 py-2 text-sm text-neutral-100 whitespace-pre-wrap leading-relaxed">
        {text}
      </div>
    </div>
  );
}
