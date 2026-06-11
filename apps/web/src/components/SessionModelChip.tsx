import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import type { ModelSelection, SessionDTO } from '@argus/shared-types';
import { api } from '../lib/api';
import { useSessionStore } from '../stores/sessionStore';
import { ModelPicker, modelSelectionLabel, useModelCatalog } from './ModelPicker';
import { cn } from '../lib/utils';

/**
 * Session-header chip showing the session's model default; clicking
 * opens the same ModelPicker the new-session dialog uses. Changes
 * apply to SUBSEQUENT turns (the in-flight one already carries its
 * merged options).
 *
 * The draft is committed once on close (outside click / Escape), not
 * per change — the custom free-text path would otherwise PATCH per
 * keystroke. The catalog is only fetched while the popover is open
 * (`agentId` is nulled when closed), so rendering a session header
 * never triggers a sidecar CLI exec; the chip label degrades to the
 * raw model id until the picker has been opened once.
 */
export function SessionModelChip({
  session,
  agentId,
}: {
  session: SessionDTO;
  agentId: string | undefined;
}) {
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ModelSelection | null>(session.modelSelection ?? null);
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // null while closed → no fetch; module/server caches make reopening cheap.
  const { catalog } = useModelCatalog(open ? (agentId ?? null) : null);

  // Resync the draft when another browser/dialog changes the session.
  useEffect(() => {
    if (!open) setDraft(session.modelSelection ?? null);
  }, [session.modelSelection, open]);

  async function commit(next: ModelSelection | null) {
    // Empty custom input normalizes to "Default".
    const normalized = next?.model ? next : null;
    const before = session.modelSelection ?? null;
    if (JSON.stringify(normalized) === JSON.stringify(before)) return;
    setSaving(true);
    try {
      const updated = await api.setSessionModel(session.id, normalized);
      upsertSession(updated);
    } catch {
      // Revert the chip to the server's truth; the next open shows it.
      setDraft(before);
    } finally {
      setSaving(false);
    }
  }

  // commit() reads the latest draft through a ref so the close
  // listeners (bound once per open) don't capture a stale value.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    if (!open) return;
    function close() {
      setOpen(false);
      void commit(draftRef.current);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session.id]);

  const label = modelSelectionLabel(open ? draft : (session.modelSelection ?? null), catalog);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="session model — applies to the next turn"
        className={cn(
          'inline-flex max-w-56 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
          open || session.modelSelection
            ? 'bg-surface-2 text-fg-secondary'
            : 'text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-secondary',
        )}
      >
        <Cpu className="h-3 w-3 shrink-0" />
        <span className="truncate">{saving ? 'saving…' : label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-[352px] max-w-[calc(100vw-16px)] rounded-lg border border-default bg-surface-0 p-3 shadow-2xl">
          <div className="mb-2 text-caps">session model</div>
          <ModelPicker agentId={agentId ?? null} value={draft} onChange={setDraft} />
        </div>
      )}
    </div>
  );
}
