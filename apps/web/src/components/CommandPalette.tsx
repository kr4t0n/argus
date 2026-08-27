import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowRightLeft, Loader2, Search } from 'lucide-react';
import {
  SEARCH_HL_START,
  SEARCH_HL_STOP,
  type SessionDTO,
  type SessionSearchHitDTO,
} from '@argus/shared-types';
import { api } from '../lib/api';
import { useSessionStore } from '../stores/sessionStore';
import { useProjectStore } from '../stores/projectStore';
import { useMachineStore } from '../stores/machineStore';
import { usePaletteStore, type PaletteMode } from '../stores/paletteStore';
import { basename, resolveProjectRef } from '../lib/projects';
import { rankSessions, type SessionCandidate } from '../lib/sessionMatch';
import { useGlobalHotkey } from '../lib/useGlobalHotkey';
import { AgentTypeIcon } from './ui/AgentTypeIcon';
import { cn } from '../lib/utils';

/** Debounce before firing a content query. Long enough that typing a word
 *  is one request, short enough to feel live. Session mode has no
 *  debounce — it never leaves the browser. */
const DEBOUNCE_MS = 200;
/** Server rejects anything shorter; mirrored here to avoid the round-trip. */
const MIN_CONTENT_QUERY = 2;
/** Rows shown in session mode, including the zero-query recents list. */
const SESSION_LIMIT = 12;

/**
 * The command palette. One overlay, two modes:
 *
 *   ⌘P  session — switch by NAME. Ranked client-side over the session
 *                 list the app already hydrates at boot, so it is instant
 *                 and needs no API. Empty query lists recent live
 *                 sessions, which makes switching two keystrokes.
 *   ⌘K  content — search what was SAID. Server-side full text over
 *                 prompts and answers, archived included, snippets
 *                 highlighted.
 *
 * They are one component rather than two overlays because the alternative
 * is two of them negotiating which is visible when you press the other's
 * hotkey. Here that press is just a mode change.
 *
 * Portal-to-body + Escape + body-scroll-lock follows ImageLightbox, so the
 * overlay escapes the transcript's scroll/clip containers.
 */
export function CommandPalette() {
  const mode = usePaletteStore((s) => s.mode);
  const toggle = usePaletteStore((s) => s.toggle);
  const openPalette = usePaletteStore((s) => s.open);
  const close = usePaletteStore((s) => s.close);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SessionSearchHitDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useGlobalHotkey('p', useCallback(() => toggle('session'), [toggle]));
  useGlobalHotkey('k', useCallback(() => toggle('content'), [toggle]));

  const open = mode !== null;

  // ── session mode: rank the hydrated list, no network ──────────────
  const sessions = useSessionStore((s) => s.sessions);
  const projects = useProjectStore((s) => s.projects);
  const machines = useMachineStore((s) => s.machines);

  const candidates = useMemo<SessionCandidate[]>(() => {
    if (mode !== 'session') return [];
    return Object.values(sessions).map((session) => {
      const ref = resolveProjectRef(session, projects);
      return {
        session,
        projectLabel: ref ? basename(ref.workingDir) : null,
        machineName: ref ? (machines[ref.machineId]?.name ?? null) : null,
      };
    });
  }, [mode, sessions, projects, machines]);

  const ranked = useMemo(
    () => (mode === 'session' ? rankSessions(query, candidates, SESSION_LIMIT) : []),
    [mode, query, candidates],
  );

  // Rows are keyed by session id in both modes, so navigation and the
  // keyboard cursor can be written once.
  const rowIds = mode === 'session' ? ranked.map((r) => r.session.id) : hits.map((h) => h.sessionId);

  // ── per-open reset ────────────────────────────────────────────────
  // Keyed on `open`, not `mode`, so switching modes with Tab keeps what
  // you typed — the whole point of the toggle is re-running the same
  // words against the other index.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setCursor(0);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Escape from anywhere, not just the input — focus moves to a result
  // button the moment the user clicks one.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // ── content mode: debounced server query ──────────────────────────
  useEffect(() => {
    if (mode !== 'content') return;
    const q = query.trim();
    if (q.length < MIN_CONTENT_QUERY) {
      setHits([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api
        .searchSessions(q, { signal: ctrl.signal })
        .then((res) => {
          setHits(res.hits);
          setCursor(0);
        })
        .catch(() => {
          /* aborted or failed — leave the previous page up */
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, mode]);

  // Ranking is synchronous, so the cursor can outlive a shrinking list.
  useEffect(() => {
    setCursor((c) => (c >= rowIds.length ? 0 : c));
  }, [rowIds.length]);

  const openRow = useCallback(
    (index: number) => {
      if (mode === 'session') {
        const hit = ranked[index];
        if (!hit) return;
        // No `?turn=` — plain navigation, which resets to the tail window.
        // "Switch to this session" means show me the present.
        navigate(`/sessions/${hit.session.id}`);
      } else {
        const hit = hits[index];
        if (!hit) return;
        // `?turn=` lands the viewer on the turn that actually matched.
        navigate(`/sessions/${hit.sessionId}?turn=${encodeURIComponent(hit.commandId)}`);
      }
      close();
    },
    [mode, ranked, hits, navigate, close],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(rowIds.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openRow(cursor);
    } else if (e.key === 'Tab') {
      // Same words, other index. Keeping the query is what makes this
      // useful: "I thought I'd remember the title, but I remember a
      // phrase from the answer instead."
      e.preventDefault();
      openPalette(mode === 'session' ? 'content' : 'session');
      setCursor(0);
    }
  };

  // Keep the keyboard cursor inside the scroll viewport.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, rowIds.length]);

  if (!open) return null;

  const sessionMode = mode === 'session';
  const contentTooShort = !sessionMode && query.trim().length < MIN_CONTENT_QUERY;
  const showEmpty = !loading && !contentTooShort && rowIds.length === 0;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={sessionMode ? 'Switch session' : 'Search sessions'}
      onMouseDown={close}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh] animate-in fade-in duration-100"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-default bg-surface-0 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-default px-3">
          {sessionMode ? (
            <ArrowRightLeft size={15} className="shrink-0 text-fg-muted" />
          ) : (
            <Search size={16} className="shrink-0 text-fg-muted" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={
              sessionMode ? 'Switch to session…' : 'Search what was said in all sessions…'
            }
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent py-3 text-sm text-fg-primary outline-none placeholder:text-fg-muted"
          />
          {loading && <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />}
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
          {sessionMode
            ? ranked.map((r, i) => (
                <SessionRow
                  key={r.session.id}
                  session={r.session}
                  projectLabel={r.projectLabel}
                  machineName={r.machineName}
                  idx={i}
                  active={i === cursor}
                  onSelect={() => openRow(i)}
                  onHover={() => setCursor(i)}
                />
              ))
            : hits.map((hit, i) => (
                <ContentRow
                  key={hit.sessionId}
                  hit={hit}
                  idx={i}
                  active={i === cursor}
                  onSelect={() => openRow(i)}
                  onHover={() => setCursor(i)}
                />
              ))}

          {contentTooShort && (
            <p className="px-4 py-6 text-center text-sm text-fg-tertiary">
              Search prompts and answers across every session.
            </p>
          )}
          {showEmpty && (
            <p className="px-4 py-6 text-center text-sm text-fg-tertiary">
              {query.trim() ? `No matches for “${query.trim()}”` : 'No sessions yet.'}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-default px-3 py-1.5 text-[11px] text-fg-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> open · <Kbd>tab</Kbd>{' '}
            {sessionMode ? 'search content' : 'switch session'} · <Kbd>esc</Kbd> close
          </span>
          {rowIds.length > 0 && (
            <span>
              {rowIds.length} {sessionMode ? 'sessions' : 'matches'}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** ⌘P row: what the session is called and where it lives. */
function SessionRow({
  session,
  projectLabel,
  machineName,
  idx,
  active,
  onSelect,
  onHover,
}: {
  session: SessionDTO;
  projectLabel: string | null;
  machineName: string | null;
  idx: number;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(
        'flex w-full items-center gap-2 border-b border-default/50 px-3 py-2 text-left transition-colors last:border-b-0',
        active ? 'bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      {session.cliType && <AgentTypeIcon type={session.cliType} size={13} />}
      <span className="truncate text-sm text-fg-primary">{session.title}</span>
      {session.archivedAt && (
        <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[10px] uppercase tracking-wide text-fg-muted">
          archived
        </span>
      )}
      {(projectLabel || machineName) && (
        <span className="ml-auto shrink-0 truncate pl-3 text-[11px] text-fg-muted">
          {[projectLabel, machineName].filter(Boolean).join(' · ')}
        </span>
      )}
    </button>
  );
}

/** ⌘K row: the session plus why it matched. */
function ContentRow({
  hit,
  idx,
  active,
  onSelect,
  onHover,
}: {
  hit: SessionSearchHitDTO;
  idx: number;
  active: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  // Session metadata is resolved from the stores the app already holds —
  // the whole session list is hydrated at boot — so the search response
  // carries only ids and snippets.
  const session = useSessionStore((s) => s.sessions[hit.sessionId]);
  const projects = useProjectStore((s) => s.projects);
  const machines = useMachineStore((s) => s.machines);

  const ref = useMemo(() => resolveProjectRef(session, projects), [session, projects]);
  const projectLabel = ref ? basename(ref.workingDir) : null;
  const machineName = ref ? machines[ref.machineId]?.name : null;

  // A hit whose session hasn't hydrated yet (or was deleted under us)
  // still gets a row — the snippet is the useful part and dropping it
  // would silently under-report the result count.
  const title = session?.title ?? 'Untitled session';

  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(
        'flex w-full flex-col gap-1 border-b border-default/50 px-3 py-2.5 text-left transition-colors last:border-b-0',
        active ? 'bg-surface-2' : 'hover:bg-surface-1',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {session?.cliType && <AgentTypeIcon type={session.cliType} size={13} />}
        <span className="truncate text-sm font-medium text-fg-primary">{title}</span>
        {session?.archivedAt && (
          <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[10px] uppercase tracking-wide text-fg-muted">
            archived
          </span>
        )}
        {hit.matchCount > 1 && (
          <span className="ml-auto shrink-0 text-[11px] text-fg-muted">
            {hit.matchCount} turns
          </span>
        )}
      </div>
      <p className="line-clamp-2 text-xs leading-relaxed text-fg-tertiary">
        {renderSnippet(hit.snippet)}
      </p>
      {(projectLabel || machineName) && (
        <p className="truncate text-[11px] text-fg-muted">
          {[projectLabel, machineName].filter(Boolean).join(' · ')}
        </p>
      )}
    </button>
  );
}

/**
 * Turn the server's `[[hl]]`-marked snippet into React nodes.
 *
 * The sentinels exist precisely so this never goes through
 * dangerouslySetInnerHTML — transcript text is model- and user-authored
 * and must never reach an HTML sink. Unpaired markers are left as literal
 * text rather than swallowing the rest of the snippet.
 */
function renderSnippet(snippet: string) {
  // Collapse the doc's newlines so a row stays two lines tall.
  const flat = snippet.replace(/\s+/g, ' ').trim();
  const out: React.ReactNode[] = [];
  let rest = flat;
  let key = 0;
  for (;;) {
    const start = rest.indexOf(SEARCH_HL_START);
    if (start < 0) break;
    const stop = rest.indexOf(SEARCH_HL_STOP, start + SEARCH_HL_START.length);
    if (stop < 0) break;
    if (start > 0) out.push(rest.slice(0, start));
    out.push(
      <mark key={key++} className="rounded bg-amber-400/30 px-0.5 text-fg-primary">
        {rest.slice(start + SEARCH_HL_START.length, stop)}
      </mark>,
    );
    rest = rest.slice(stop + SEARCH_HL_STOP.length);
  }
  out.push(rest);
  return out;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-default px-1 py-px font-sans text-[10px] text-fg-secondary">
      {children}
    </kbd>
  );
}
