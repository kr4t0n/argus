import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search } from 'lucide-react';
import {
  SEARCH_HL_START,
  SEARCH_HL_STOP,
  type SessionSearchHitDTO,
} from '@argus/shared-types';
import { api } from '../lib/api';
import { useSessionStore } from '../stores/sessionStore';
import { useProjectStore } from '../stores/projectStore';
import { useMachineStore } from '../stores/machineStore';
import { basename, resolveProjectRef } from '../lib/projects';
import { AgentTypeIcon } from './ui/AgentTypeIcon';
import { cn } from '../lib/utils';

/** Debounce before firing a query. Long enough that typing a word is one
 *  request, short enough to feel live. */
const DEBOUNCE_MS = 200;
/** Server rejects anything shorter; mirrored here to avoid the round-trip. */
const MIN_QUERY = 2;

/**
 * ⌘K content search across every session — archived included.
 *
 * Deliberately unscoped: 93% of sessions in real use are archived, so a
 * default of "visible sessions only" would search ~7% of history and
 * make the scope control the primary interface. Archived hits are
 * labelled instead of hidden.
 *
 * Portal-to-body + Escape + body-scroll-lock follows ImageLightbox, so
 * the overlay escapes the transcript's scroll/clip containers.
 */
export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SessionSearchHitDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // ⌘K / Ctrl+K anywhere. Capture phase and preventDefault because the
  // xterm terminal pane would otherwise forward the keystroke to the PTY,
  // and Firefox maps Ctrl+K to its own search bar. A modifier combo is
  // why this needs no "is the user typing?" guard — unlike a bare key,
  // it can't fire by accident mid-sentence.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  // Escape from anywhere, not just the input — focus moves to a result
  // button the moment the user clicks one, and Escape has to keep
  // working after that.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Reset per-open so ⌘K always lands on an empty box rather than the
  // last search's stale results.
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

  // Debounced query. The AbortController is what keeps results honest
  // while typing: without it a slow early request can resolve after a
  // fast later one and overwrite good results with stale ones.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_QUERY) {
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
  }, [query, open]);

  const openHit = useCallback(
    (hit: SessionSearchHitDTO) => {
      // `?turn=` lands the viewer on the turn that actually matched rather
      // than the newest one — the session loads a window centred there.
      navigate(`/sessions/${hit.sessionId}?turn=${encodeURIComponent(hit.commandId)}`);
      setOpen(false);
    },
    [navigate],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[cursor];
      if (hit) openHit(hit);
    }
  };

  // Keep the keyboard cursor inside the scroll viewport.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${cursor}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, hits]);

  if (!open) return null;

  const showEmpty = !loading && query.trim().length >= MIN_QUERY && hits.length === 0;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search sessions"
      onMouseDown={close}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh] animate-in fade-in duration-100"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-default bg-surface-0 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-default px-3">
          <Search size={16} className="shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search all sessions…"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-transparent py-3 text-sm text-fg-primary outline-none placeholder:text-fg-muted"
          />
          {loading && <Loader2 size={14} className="shrink-0 animate-spin text-fg-muted" />}
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto">
          {hits.map((hit, i) => (
            <ResultRow
              key={hit.sessionId}
              hit={hit}
              idx={i}
              active={i === cursor}
              onSelect={() => openHit(hit)}
              onHover={() => setCursor(i)}
            />
          ))}
          {showEmpty && (
            <p className="px-4 py-6 text-center text-sm text-fg-tertiary">
              No matches for “{query.trim()}”
            </p>
          )}
          {!loading && query.trim().length < MIN_QUERY && (
            <p className="px-4 py-6 text-center text-sm text-fg-tertiary">
              Search prompts and answers across every session.
            </p>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-default px-3 py-1.5 text-[11px] text-fg-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate · <Kbd>↵</Kbd> open · <Kbd>esc</Kbd> close
          </span>
          {hits.length > 0 && <span>{hits.length} sessions</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ResultRow({
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
 * and must never reach an HTML sink. Unpaired markers are left as
 * literal text rather than swallowing the rest of the snippet.
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
