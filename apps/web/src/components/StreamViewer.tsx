import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle } from 'lucide-react';
import type { CommandDTO, ResultChunkDTO } from '@argus/shared-types';
import { splitDeltas } from '../lib/deltaSplit';
import { ActivityPanel, ActivityPill } from './ActivityPill';
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
      className="h-full overflow-y-auto overflow-x-hidden px-6 pb-6"
    >
      <div className="mx-auto max-w-3xl">
        {grouped.length === 0 && (
          <div className="flex h-full items-center justify-center pt-32 text-sm text-neutral-500">
            Send a prompt to start the conversation.
          </div>
        )}
        {grouped.map((g, i) => (
          <CommandBlock
            key={g.command.id}
            command={g.command}
            chunks={g.chunks}
            running={running && isLast(g, grouped)}
            workingDir={workingDir}
            isFirst={i === 0}
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
  isFirst,
}: {
  command: CommandDTO;
  chunks: ResultChunkDTO[];
  running: boolean;
  workingDir?: string | null;
  isFirst: boolean;
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

  // Activity panel open-state lives here (lifted out of ActivityPill) so
  // the capsule can ride inside a sticky header band while the expanded
  // panel scrolls naturally below it.
  const [activityOpen, setActivityOpen] = useState(false);
  const bandRef = useRef<HTMLDivElement>(null);

  // Snap THIS turn's band to the top of the scrollport on every toggle,
  // in both directions:
  //
  //   • Collapse while scrolled deep: the panel (which sat between the
  //     band and the body) unmounts, so scrollTop would leave the user
  //     looking at the middle of the body (or past it entirely).
  //   • Expand while scrolled deep in the body: the panel mounts ABOVE
  //     the current scroll position, so the user either ends up with
  //     the panel above the viewport (browser scroll anchoring) or
  //     lands mid-panel — either way, not where the tool results
  //     actually are.
  //
  // Snapping to the band's natural y puts the band at top:0 with the
  // panel (or body, when collapsing) picking up right under it.
  const handleActivityToggle = useCallback(() => {
    setActivityOpen((wasOpen) => {
      const next = !wasOpen;
      const band = bandRef.current;
      const scroller = band ? findScrollParent(band) : null;
      if (!band || !scroller) return next;
      // Skip the snap when the user is browsing history (scrolled away
      // from the live edge). Snapping to this turn's band would yank
      // their view to a turn they didn't ask to visit. The 48px mirrors
      // the StreamViewer `stickBottom` threshold.
      const nearBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      if (!nearBottom) return next;
      // `position: sticky` doesn't change layout, but its current PAINT
      // position can mask the band's natural in-flow location once it's
      // stuck at top:0. Toggle to `static` for a beat to read the real
      // in-flow rect; the two style writes happen synchronously so no
      // intermediate frame is painted. The band's natural y is
      // unaffected by the panel mount/unmount (panel is AFTER the band
      // in DOM), so this measurement is valid for both directions.
      const prev = band.style.position;
      band.style.position = 'static';
      const bandRect = band.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const naturalTop = scroller.scrollTop + bandRect.top - scrollerRect.top;
      band.style.position = prev;
      // Defer one frame so React has committed the mount/unmount before
      // we scroll — otherwise scrollTo runs against the pre-commit
      // layout and we land in the wrong place.
      requestAnimationFrame(() => {
        scroller.scrollTo({ top: naturalTop });
      });
      return next;
    });
  }, []);

  // Per-turn WRAPPER (vs a fragment) is what gives the sticky bands a
  // PUSH transition between turns. Each band's containing block is its
  // own turn, so as the user scrolls down through turn N, the wrapper's
  // bottom edge eventually crosses `top:0` and pushes band N up out of
  // the scrollport. Turn N+1's wrapper top is at exactly that same y,
  // so band N+1 sticks at `top:0` glued to where band N just left —
  // the result is a continuous "card slides up, next card slides in"
  // motion rather than the new band ghosting on top of the old one
  // (which is what a shared containing block produces, because both
  // bands try to stick at `top:0` at once and the later DOM wins paint).
  //
  // Spacing between turns lives entirely INSIDE the band's bg
  // (`pt-6` / `pt-2` for the first turn) so there's no uncovered gap
  // at the boundary — wrapper itself has no margin/padding, otherwise
  // a sliver of body bg would briefly show between turns where neither
  // band is pinned.
  return (
    <div>
      <div
        ref={bandRef}
        className={`sticky top-0 z-10 space-y-3 bg-neutral-950 pb-3 ${isFirst ? 'pt-2' : 'pt-6'}`}
      >
        {command.prompt && <UserMessage text={command.prompt} />}
        <ActivityPill
          chunks={chunks}
          running={running && !finalChunk && !errorChunk}
          startedAt={startedAt}
          endedAt={endedAt}
          open={activityOpen}
          onToggle={handleActivityToggle}
        />
      </div>

      {activityOpen && (
        <div className="mt-4">
          <ActivityPanel chunks={chunks} />
        </div>
      )}

      {bodyText && (
        <div className="markdown mt-4 text-sm leading-relaxed text-neutral-200 max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{bodyText}</ReactMarkdown>
          {running && !finalChunk && !errorChunk && (
            <span className="typewriter-cursor" />
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-4">
          <FileChips files={files} workingDir={workingDir} />
        </div>
      )}

      {errorChunk && (
        <div className="mt-4 flex items-start gap-2.5 rounded-md border border-red-900/50 bg-red-950/20 px-3 py-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
          <pre className="text-xs font-mono text-red-300 whitespace-pre-wrap">
            {errorChunk.content ?? 'error'}
          </pre>
        </div>
      )}
    </div>
  );
}

/** Walk up to the nearest ancestor that actually scrolls vertically. */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-h-36 max-w-[80%] overflow-y-auto no-scrollbar rounded-2xl bg-neutral-800/80 px-4 py-2 text-sm text-neutral-100 whitespace-pre-wrap leading-relaxed">
        {text}
      </div>
    </div>
  );
}
