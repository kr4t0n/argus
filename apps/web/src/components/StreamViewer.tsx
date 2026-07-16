import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, Check, Copy, FileText, GitBranch, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { AttachmentDTO, CommandDTO, ResultChunkDTO } from '@argus/shared-types';
import { api, ApiError, apiUrl } from '../lib/api';
import { useSessionStore } from '../stores/sessionStore';
import { splitDeltas } from '../lib/deltaSplit';
import { ActivityPanel, ActivityPill } from './ActivityPill';
import { FileChips, extractFiles, splitLineSuffix, toAgentRelative } from './FileChips';
import type { ProjectRef } from '../lib/projects';
import { TodoWindow } from './TodoWindow';
import { SubAgentWindow } from './SubAgentWindow';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { Tooltip } from './ui/Tooltip';
import { copyTextToClipboard } from '../lib/clipboard';
import { useFileTabsStore } from '../stores/fileTabsStore';

type Props = {
  /** Owning session — keys the remembered scroll position. */
  sessionId: string;
  commands: CommandDTO[];
  chunks: ResultChunkDTO[];
  running: boolean;
  /** Anchor used to relativize file chip paths (the project's workingDir). */
  workingDir?: string | null;
  /** Project the session is pinned to — drives file-preview opens
   *  (project-addressed fs-read) and scopes attachment tabs. Null for
   *  workdir-less sessions: citations render inert, attachments open
   *  in a browser tab instead of the preview strip. */
  project: ProjectRef | null;
  /** True iff more history exists on the server (tail-window pagination). */
  hasMore?: boolean;
  loadingOlder?: boolean;
  /** Called when the user scrolls near the top and we should fetch the
   *  next page of older commands. */
  onLoadOlder?: () => void;
};

/** How close to the top (px) before we trigger a fetch of older history. */
const LOAD_OLDER_THRESHOLD = 200;

/** Per-session chat scroll position, remembered across unmounts so that
 *  opening a file tab — which swaps StreamViewer out for FileViewer — and
 *  closing it returns the user to where they were instead of snapping to
 *  the bottom. Module-level + ephemeral: fine to lose on a full reload. */
const scrollMemory = new Map<string, { top: number; atBottom: boolean }>();

/**
 * Open-Agents-style chronological feed:
 *   • user prompt as a right-aligned dark pill
 *   • a single "activity" capsule summarising tools + elapsed time (expandable)
 *   • the assistant message as plain markdown body
 *   • file chips for files the agent touched
 *   • errors surfaced inline.
 */
export function StreamViewer({
  sessionId,
  commands,
  chunks,
  running,
  workingDir,
  project,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [stickBottom, setStickBottom] = useState<boolean>(
    () => scrollMemory.get(sessionId)?.atBottom ?? true,
  );

  // Restore the chat's remembered scroll position on (re)mount — a file
  // tab swaps this component out and back, and without this the chat would
  // snap to the bottom (stickBottom defaults to true). The position is
  // recorded continuously in onScroll rather than at unmount: reading the
  // element during teardown is unreliable (the node is mid-detach and
  // reports scrollTop/clientHeight as ~0, which looks like "at bottom").
  // When the user was at the bottom we let the normal stick-to-bottom
  // effect handle it; otherwise we pin scrollTop back to where they were.
  useLayoutEffect(() => {
    const el = ref.current;
    const saved = scrollMemory.get(sessionId);
    if (el && saved && !saved.atBottom) el.scrollTop = saved.top;
    // mount-only restore
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const anchorEl = el.querySelector<HTMLElement>(`[data-cmd-id="${CSS.escape(pending.id)}"]`);
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
    const anchorEl = el.querySelector<HTMLElement>(`[data-cmd-id="${CSS.escape(anchor.id)}"]`);
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
    // Record continuously so the position survives this component's unmount
    // (opening a file tab) — reading the element at unmount is unreliable.
    scrollMemory.set(sessionId, { top: el.scrollTop, atBottom: nearBottom });
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
          <div className="flex items-center justify-center py-4 text-xs text-fg-tertiary">
            {loadingOlder ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                loading earlier turns…
              </span>
            ) : (
              <span className="text-fg-muted">scroll up for earlier turns</span>
            )}
          </div>
        )}
        {grouped.length === 0 && (
          <div className="flex h-full items-center justify-center pt-32 text-sm text-fg-tertiary">
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
            project={project}
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
  project: ProjectRef | null;
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
  project,
  isFirst,
}: CommandBlockProps) {
  // Only deltas AFTER the last tool/output chunk count as the user-facing
  // answer — earlier deltas are "thinking"/preamble the model emitted
  // between tool calls and belong in the activity timeline, not the
  // response body. See `lib/deltaSplit.ts` for the full rationale; this
  // lets adapters that emit one assistant text per reasoning step
  // (cursor-cli, claude-code) surface a clean final answer instead of a
  // glued-together transcript.
  const finalDeltaText = useMemo(() => {
    const { finalDeltas } = splitDeltas(chunks);
    return finalDeltas.map((c) => c.delta ?? '').join('');
  }, [chunks]);
  const finalChunk = chunks.find((c) => c.kind === 'final');
  const errorChunk = chunks.find((c) => c.kind === 'error');
  const files = useMemo(() => extractFiles(chunks), [chunks]);

  // A turn is "done" once it stops running or a terminal chunk lands.
  // Until then, the trailing assistant text is the model's CURRENT
  // utterance and can't be classified yet: it becomes pre-tool narration
  // if a tool follows, or the final answer if the turn ends — and we only
  // know which once the next tool arrives (or the turn settles). So while
  // the turn is live we fold ALL of its text into the activity pill (the
  // ActivityPanel renders the running deltas as thoughts, see
  // `buildTimeline(..., live)`) and keep the response body empty. Nothing
  // ever renders as a standalone block that could flash and then relocate
  // when a tool follows; the settled final answer simply lands in the
  // body once the turn is done.
  const turnDone = !running || !!finalChunk || !!errorChunk;

  // The response body only ever holds the settled final answer (the
  // post-last-tool deltas). Fall back to `final.content` only when no
  // post-tool deltas exist at all — covers adapters that publish a single
  // result event with no streamed deltas, plus the (rare) case of a turn
  // that ended on a tool call with no closing assistant message.
  const bodyText = turnDone ? finalDeltaText || finalChunk?.content?.trim() || '' : '';

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
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
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
        className={`sticky top-0 z-10 space-y-3 bg-surface-0 pb-3 ${isFirst ? 'pt-2' : 'pt-6'}`}
      >
        {(command.prompt || command.attachments?.length) && (
          <UserMessage
            text={command.prompt ?? ''}
            attachments={command.attachments}
            scope={project?.projectId ?? null}
            createdAt={command.createdAt}
          />
        )}
        <ActivityPill
          chunks={chunks}
          running={running && !finalChunk && !errorChunk}
          startedAt={startedAt}
          endedAt={endedAt}
          open={activityOpen}
          onToggle={handleActivityToggle}
        />
      </div>

      <div className="mt-4 space-y-3">
        <TodoWindow chunks={chunks} />
        <SubAgentWindow chunks={chunks} />
        {activityOpen && <ActivityPanel chunks={chunks} live={!turnDone} />}
        {(bodyText || files.length > 0) && (
          <AnswerBlock
            bodyText={bodyText}
            files={files}
            workingDir={workingDir}
            sessionId={command.sessionId}
            commandId={command.id}
            project={project}
            completedAt={command.completedAt}
          />
        )}
        {errorChunk && (
          <div className="flex items-start gap-2.5 rounded-md bg-red-500/10 px-3 py-2 dark:bg-red-950/30">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
            <pre className="text-xs font-mono text-red-700 dark:text-red-400 whitespace-pre-wrap">
              {errorChunk.content ?? 'error'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * react-markdown sanitizes every href BEFORE the custom `a` renderer
 * sees it, and `defaultUrlTransform` keeps only http(s)/mailto/relative
 * URLs. A `path:line` citation like `test.txt:1` parses as the unknown
 * scheme `test.txt:`, so the default transform blanks it to '' and the
 * renderer can no longer tell it was a file link (an empty-href anchor
 * then just reloads the current page on click). Preserve exactly the
 * hrefs that `splitLineSuffix` recognizes as `path:line`; everything
 * else keeps the default sanitization.
 */
function fileLinkUrlTransform(url: string): string {
  const safe = defaultUrlTransform(url);
  if (safe) return safe;
  return splitLineSuffix(url).line !== undefined ? url : safe;
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

/**
 * Hover-revealed timestamp for a turn, riding the same action row as the
 * copy/branch buttons.
 *
 * Absolute (not the app's usual `relativeTime` "2h ago") and always
 * date-qualified, for one shared reason: <CommandBlock> is memo'd, so a
 * settled turn renders once and then never again. Anything derived from
 * "now" at render time freezes at whatever it said on that render and
 * silently drifts wrong while a session stays open — a relative label
 * goes stale within the hour, and a today-vs-earlier check that drops
 * the date goes stale at midnight, leaving a bare clock that reads as
 * today forever. A fully-qualified stamp needs no re-render to stay
 * honest, and every turn reads the same way.
 *
 * One `toLocaleString` rather than date + ', ' + time: the separator and
 * field order are the locale's business, not ours. The full timestamp
 * (with seconds) rides the tooltip.
 */
function MessageTime({ iso }: { iso: string | null }) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <Tooltip content={d.toLocaleString()}>
      <span className="cursor-default select-none px-1 text-[11px] tabular-nums text-fg-muted">
        {d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
    </Tooltip>
  );
}

function AnswerBlock({
  bodyText,
  files,
  workingDir,
  sessionId,
  commandId,
  project,
  completedAt,
}: {
  bodyText: string;
  files: ReturnType<typeof extractFiles>;
  workingDir?: string | null;
  sessionId: string;
  commandId: string;
  project: ProjectRef | null;
  /** When the turn settled — the response's timestamp. Null for turns
   *  that never completed (e.g. cancelled), which just render no time. */
  completedAt: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const openFile = useFileTabsStore((s) => s.openFile);

  // Render markdown anchors so paths that resolve inside the agent's
  // workspace open the file preview on double-click (matching the
  // FileChips affordance) instead of trying to navigate the browser
  // to a relative URL like `site/src/foo.astro`, which the browser
  // would resolve against the current host.
  const markdownComponents = useMemo(
    () => ({
      pre: MarkdownCodeBlock,
      a({ href, children }: { href?: string; children?: React.ReactNode }) {
        // Strip a `path:line` citation suffix BEFORE the URL-scheme test:
        // `xxx.txt:1` would otherwise parse as scheme `xxx.txt` and render
        // as a (broken) external anchor. Real URLs survive the split —
        // `http://localhost:3000` strips to `http://localhost`, which
        // still matches the scheme test below and falls through as a
        // normal anchor with the ORIGINAL href.
        // No href at all — e.g. an unknown-scheme URL that
        // fileLinkUrlTransform didn't rescue and sanitization blanked.
        // An empty-href anchor is a live link to the CURRENT page, so
        // render inert text instead.
        if (!href) {
          return <span className="break-words font-mono text-fg-secondary">{children}</span>;
        }
        const { path: hrefPath, line } = splitLineSuffix(href);
        // Real URLs / fragments / mail / tel — leave as a normal anchor,
        // but force a new tab so they can't replace the app.
        if (/^[a-z][a-z0-9+\-.]*:/i.test(hrefPath) || href.startsWith('#')) {
          return (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        }
        const rel = toAgentRelative(hrefPath, workingDir);
        if (!rel || !project) {
          // Outside the workspace, a directory, or we have no agent
          // to fetch from — render as inert text so the broken
          // relative URL can't be followed by a stray click.
          return <span className="break-words font-mono text-fg-secondary">{children}</span>;
        }
        return (
          <span
            role="button"
            tabIndex={0}
            title="Double-click to preview"
            onDoubleClick={() => openFile({ project, path: rel, line })}
            className="cursor-pointer select-none break-words text-sky-600 hover:underline dark:text-sky-400"
          >
            {children}
          </span>
        );
      },
    }),
    [project, workingDir, openFile],
  );

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

  const handleFork = useCallback(async () => {
    if (forking) return;
    setForking(true);
    setForkError(null);
    try {
      const session = await api.forkSession(sessionId, { commandId });
      upsertSession(session);
      navigate(`/sessions/${session.id}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'fork failed';
      setForkError(msg);
      // Clear the inline error after a beat — same cadence as the copy
      // confirmation so the surrounding hover affordance settles.
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setForkError(null), 2500);
    } finally {
      setForking(false);
    }
  }, [forking, sessionId, commandId, upsertSession, navigate]);

  // Touch devices don't have hover, and tapping a `tabIndex=0` div
  // doesn't reliably focus it across mobile browsers — focus explicitly
  // on touch-originated pointers only, so mouse-selection isn't hijacked.
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') e.currentTarget.focus();
  }, []);

  return (
    <div
      className="group relative focus:outline-none"
      tabIndex={0}
      onPointerUp={handlePointerUp}
    >
      {bodyText && (
        <div className="markdown text-sm leading-relaxed text-fg-primary max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
            urlTransform={fileLinkUrlTransform}
          >
            {bodyText}
          </ReactMarkdown>
        </div>
      )}
      {files.length > 0 && (
        <div className={bodyText ? 'mt-4' : ''}>
          <FileChips files={files} workingDir={workingDir} project={project} />
        </div>
      )}
      {bodyText && (
        <div className="mt-2 flex items-center gap-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
          <Tooltip content={copied ? 'Copied' : 'Copy as markdown'}>
            <button
              type="button"
              onClick={handleCopy}
              aria-label="Copy response as markdown"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface-2/60 hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-500/80" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </Tooltip>
          <Tooltip
            content={forkError ?? (forking ? 'Branching…' : 'Branch session from this turn')}
          >
            <button
              type="button"
              onClick={handleFork}
              disabled={forking}
              aria-label="Branch session from this turn"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface-2/60 hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary disabled:opacity-50"
            >
              {forking ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <GitBranch className="h-3 w-3" />
              )}
            </button>
          </Tooltip>
          {/* Trails the buttons so adding it can't shift their position. */}
          <MessageTime iso={completedAt} />
        </div>
      )}
    </div>
  );
}

function UserMessage({
  text,
  attachments,
  scope,
  createdAt,
}: {
  text: string;
  attachments?: AttachmentDTO[];
  scope: string | null;
  /** When the turn was dispatched — the user message's own timestamp. */
  createdAt: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function update() {
    const el = ref.current;
    if (!el) return;
    const overflowing = el.scrollHeight - el.clientHeight > 1;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    setShowFade(overflowing && !atBottom);
  }

  useLayoutEffect(update, [text]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <div className="group flex flex-col items-end">
      {attachments && attachments.length > 0 && (
        <div className="mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-2">
          {attachments.map((a) => (
            <AttachmentBubble key={a.id} attachment={a} scope={scope} />
          ))}
        </div>
      )}
      {/* Outer wrapper owns rounded-2xl + overflow-hidden so Safari's
          rubber-band overscroll can't paint past the corner. */}
      {text && (
        <div className="max-w-[80%] overflow-hidden rounded-2xl bg-surface-1 dark:bg-surface-2/80">
          <div
            ref={ref}
            onScroll={update}
            className="max-h-24 overflow-y-auto no-scrollbar px-4 py-2 text-sm text-fg-primary whitespace-pre-wrap leading-relaxed"
            style={
              showFade
                ? {
                    maskImage:
                      'linear-gradient(to bottom, black calc(100% - 24px), transparent 100%)',
                    WebkitMaskImage:
                      'linear-gradient(to bottom, black calc(100% - 24px), transparent 100%)',
                  }
                : undefined
            }
          >
            {text}
          </div>
        </div>
      )}
      {/* Gated on text OR attachments (rather than text alone, as the copy
          button was) so an image-only turn still reveals its timestamp. */}
      {(text || attachments?.length) && (
        <div className="mt-1 flex items-center gap-1 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
          <MessageTime iso={createdAt} />
          {text && (
            <Tooltip content={copied ? 'Copied' : 'Copy message'}>
              <button
                type="button"
                onClick={handleCopy}
                aria-label="Copy user message"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface-2/60 hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500/80" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/** One attached file on a user turn. Double-click opens it as a tab in the
 *  main viewer — the same gesture and destination as the Files panel, so
 *  the file-open UX is uniform across the app. Images render a thumbnail;
 *  other files render a chip. The tokenized url authenticates via its
 *  `?t=` param (no Authorization header needed for `<img>` / fetch). */
function AttachmentBubble({
  attachment,
  scope,
}: {
  attachment: AttachmentDTO;
  scope: string | null;
}) {
  const href = apiUrl(attachment.url);
  const openAttachment = useFileTabsStore((s) => s.openAttachment);
  const open = () => {
    // No project scope (workdir-less session) — there's no tab strip
    // to land in, so fall back to the browser's own viewer.
    if (!scope) {
      window.open(href, '_blank', 'noopener');
      return;
    }
    openAttachment({
      scope,
      id: attachment.id,
      url: href,
      name: attachment.filename,
      mime: attachment.mime,
      size: attachment.size,
    });
  };

  if (attachment.mime.startsWith('image/')) {
    return (
      <button
        type="button"
        onDoubleClick={open}
        title={`Double-click to open ${attachment.filename}`}
        aria-label={`Open ${attachment.filename}`}
        className="block cursor-pointer overflow-hidden rounded-xl border border-default transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-fg-tertiary"
      >
        <img src={href} alt={attachment.filename} loading="lazy" className="h-28 w-28 object-cover" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onDoubleClick={open}
      title={`Double-click to open ${attachment.filename}`}
      aria-label={`Open ${attachment.filename}`}
      className="flex cursor-pointer items-center gap-2 rounded-xl border border-default bg-surface-1 px-3 py-2 text-xs text-fg-secondary transition-colors hover:bg-surface-2 dark:bg-surface-2/80"
    >
      <FileText className="h-4 w-4 shrink-0 text-fg-tertiary" />
      <span className="max-w-[12rem] truncate">{attachment.filename}</span>
      <span className="shrink-0 text-fg-muted">{formatBytes(attachment.size)}</span>
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
