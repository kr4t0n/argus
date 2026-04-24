import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, Check, Copy, Loader2 } from 'lucide-react';
import type { CommandDTO, ResultChunkDTO } from '@argus/shared-types';
import { splitDeltas } from '../lib/deltaSplit';
import { ActivityPanel, ActivityPill } from './ActivityPill';
import { FileChips, extractFiles } from './FileChips';
import { Tooltip } from './ui/Tooltip';

type Props = {
  commands: CommandDTO[];
  chunks: ResultChunkDTO[];
  running: boolean;
  /** Anchor used to relativize file chip paths (`AgentDTO.workingDir`). */
  workingDir?: string | null;
  /** True iff more history exists on the server (tail-window pagination). */
  hasMore?: boolean;
  loadingOlder?: boolean;
  /** Called when the user scrolls near the top and we should fetch the
   *  next page of older commands. */
  onLoadOlder?: () => void;
};

/** How close to the top (px) before we trigger a fetch of older history. */
const LOAD_OLDER_THRESHOLD = 200;

/**
 * Open-Agents-style chronological feed:
 *   • user prompt as a right-aligned dark pill
 *   • a single "activity" capsule summarising tools + elapsed time (expandable)
 *   • the assistant message as plain markdown body
 *   • file chips for files the agent touched
 *   • errors surfaced inline.
 */
export function StreamViewer({
  commands,
  chunks,
  running,
  workingDir,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState(true);

  // Per-group stabilization: if a command's identity and chunk count are
  // both unchanged across renders, reuse the same group object (and its
  // chunks array). That gives React.memo on <CommandBlock> stable prop
  // references so untouched turns don't re-render when WS events append
  // to the live turn or prepend older history.
  const prevGroupsRef = useRef(new Map<string, Group>());
  const grouped = useMemo<Group[]>(() => {
    const next = groupByCommand(commands, chunks);
    const prev = prevGroupsRef.current;
    const stable = next.map((g) => {
      const p = prev.get(g.command.id);
      if (p && p.command === g.command && p.chunks.length === g.chunks.length) {
        return p;
      }
      return g;
    });
    const nextMap = new Map<string, Group>();
    for (const g of stable) nextMap.set(g.command.id, g);
    prevGroupsRef.current = nextMap;
    return stable;
  }, [commands, chunks]);

  useEffect(() => {
    if (!stickBottom) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    // Track commands too: a freshly-sent prompt appends a CommandDTO
    // (the user bubble) before any chunks land. Without this dep the
    // bubble would render below the fold until the agent's first
    // chunk bumped chunks.length.
  }, [chunks.length, commands.length, stickBottom]);

  // Scroll-preservation on prepend.
  //
  // When loadOlder() resolves and the store prepends N commands, the
  // viewport's scrollTop stays numerically the same but the content
  // above the user's view just grew — so everything they were looking
  // at jumps DOWN by the prepended block's height. We fix this by
  // anchoring to the oldest command that was visible BEFORE the fetch
  // and, once React has committed the new DOM, bumping scrollTop by
  // whatever delta kept that anchor at its original y.
  //
  // Anchor-relative (rather than raw scrollHeight delta) is important
  // because WS chunks may append to the live turn mid-fetch; those
  // grow scrollHeight below the viewport and would inflate a naive
  // delta calc, yanking the user past where they meant to be.
  const pendingAnchorRef = useRef<{ id: string; topBefore: number } | null>(null);

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    pendingAnchorRef.current = null;
    const el = ref.current;
    if (!el) return;
    const anchorEl = el.querySelector<HTMLElement>(
      `[data-cmd-id="${CSS.escape(pending.id)}"]`,
    );
    if (!anchorEl) return;
    const topAfter = anchorEl.getBoundingClientRect().top;
    const delta = topAfter - pending.topBefore;
    // Only compensate for DOWNWARD shifts (prepend); upward shifts
    // would mean content shrunk above the anchor, which shouldn't
    // happen on this codepath and would be unsafe to act on.
    if (delta > 1) el.scrollTop += delta;
  }, [commands]);

  const maybeLoadOlder = useCallback(() => {
    if (!onLoadOlder || !hasMore || loadingOlder) return;
    const el = ref.current;
    if (!el) return;
    if (el.scrollTop >= LOAD_OLDER_THRESHOLD) return;
    const anchor = commands[0];
    if (!anchor) return;
    // Capture the first rendered command's current y BEFORE we kick
    // off the fetch — the useLayoutEffect above uses this to keep the
    // same element pinned visually once prepend lands.
    const anchorEl = el.querySelector<HTMLElement>(
      `[data-cmd-id="${CSS.escape(anchor.id)}"]`,
    );
    const topBefore = anchorEl?.getBoundingClientRect().top ?? 0;
    pendingAnchorRef.current = { id: anchor.id, topBefore };
    onLoadOlder();
  }, [commands, hasMore, loadingOlder, onLoadOlder]);

  // Cover the case where the initial tail fits inside the viewport with
  // no scrollbar: the user can't scroll to the top because they're
  // already there, so the scroll handler never fires. We auto-page
  // older history in that scenario until the viewport fills.
  useEffect(() => {
    if (!hasMore || loadingOlder) return;
    const el = ref.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + LOAD_OLDER_THRESHOLD) {
      maybeLoadOlder();
    }
  }, [hasMore, loadingOlder, commands, maybeLoadOlder]);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setStickBottom(nearBottom);
    maybeLoadOlder();
  }

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className="h-full overflow-y-auto overflow-x-hidden px-6 pb-6"
    >
      <div className="mx-auto max-w-3xl">
        {(loadingOlder || hasMore) && (
          <div className="flex items-center justify-center py-4 text-xs text-neutral-500">
            {loadingOlder ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                loading earlier turns…
              </span>
            ) : (
              <span className="text-neutral-700">scroll up for earlier turns</span>
            )}
          </div>
        )}
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

type Group = { command: CommandDTO; chunks: ResultChunkDTO[] };

function isLast<T>(x: T, arr: T[]) {
  return arr[arr.length - 1] === x;
}

function groupByCommand(commands: CommandDTO[], chunks: ResultChunkDTO[]): Group[] {
  const map = new Map<string, Group>();
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

type CommandBlockProps = {
  command: CommandDTO;
  chunks: ResultChunkDTO[];
  running: boolean;
  workingDir?: string | null;
  isFirst: boolean;
};

// memo so unchanged turns don't re-render when a chunk lands on the
// live turn or older history prepends at the top. Default shallow
// equality is what we want: <StreamViewer>'s group-stabilization
// reuses the same chunks array ref when count is unchanged, command
// ref is unchanged when the command object is, and primitives are
// primitives.
const CommandBlock = memo(function CommandBlock({
  command,
  chunks,
  running,
  workingDir,
  isFirst,
}: CommandBlockProps) {
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
    <div data-cmd-id={command.id}>
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

      {(bodyText || files.length > 0) && (
        <AnswerBlock
          bodyText={bodyText}
          files={files}
          workingDir={workingDir}
          streaming={running && !finalChunk && !errorChunk}
        />
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
});

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

// `navigator.clipboard` is undefined outside secure contexts — which
// includes LAN access over plain http (e.g. http://192.168.x.x:5174).
// Fall back to the legacy selection+execCommand path so the button
// still works when the dev server is visited from a phone or another
// machine on the network.
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permissions denied / not allowed — try the fallback
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function AnswerBlock({
  bodyText,
  files,
  workingDir,
  streaming,
}: {
  bodyText: string;
  files: ReturnType<typeof extractFiles>;
  workingDir?: string | null;
  streaming: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(bodyText);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [bodyText]);

  // Touch devices don't have hover, and tapping a `tabIndex=0` div
  // doesn't reliably focus it across mobile browsers — focus explicitly
  // on touch-originated pointers only, so mouse-selection isn't hijacked.
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') e.currentTarget.focus();
  }, []);

  return (
    <div
      className="group relative mt-4 focus:outline-none"
      tabIndex={0}
      onPointerUp={handlePointerUp}
    >
      {bodyText && (
        <div className="markdown text-sm leading-relaxed text-neutral-200 max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{bodyText}</ReactMarkdown>
          {streaming && <span className="typewriter-cursor" />}
        </div>
      )}
      {files.length > 0 && (
        <div className={bodyText ? 'mt-4' : ''}>
          <FileChips files={files} workingDir={workingDir} />
        </div>
      )}
      {!streaming && bodyText && (
        <div className="mt-2 flex items-center gap-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
          <Tooltip content={copied ? 'Copied' : 'Copy as markdown'}>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy response as markdown"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-neutral-600 transition-colors hover:bg-neutral-800/60 hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-500/80" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
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
