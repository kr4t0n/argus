import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { PROJECT_NOTES_MAX_BYTES } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { cn } from '../lib/utils';

/**
 * Free-form scratchpad for a project — the `(machineId, workingDir)`
 * pair every session in that directory shares. Mounted per-agent in
 * the session right pane's "Note" tab (gated behind the Notes
 * extension). Two sessions in the same working dir edit the same note.
 *
 * Autosaves on a short debounce rather than behind a Save button: a
 * side-panel scratchpad you have to remember to save is a scratchpad
 * you lose. The note content is server-persisted (per user), so it
 * survives browser switches — only the on/off toggle is local UI state.
 */
export function NotePane({ machineId, workingDir }: { machineId: string; workingDir: string }) {
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getProjectNotes(machineId, workingDir)
      .then((d) => {
        if (cancelled) return;
        setText(d.notes);
        setSavedText(d.notes);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : 'failed to load note');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, workingDir]);

  // Byte-based overlimit check mirrors the server cap so multi-byte
  // text can't sneak past; the visible counter shows characters.
  const byteCount = new TextEncoder().encode(text).byteLength;
  const overLimit = byteCount > PROJECT_NOTES_MAX_BYTES;
  const dirty = text !== savedText;

  const persist = useCallback(
    async (value: string) => {
      setSaving(true);
      setSaveError(null);
      try {
        const resp = await api.setProjectNotes(machineId, workingDir, value);
        setSavedText(resp.notes);
        setJustSaved(true);
        window.setTimeout(() => setJustSaved(false), 1500);
      } catch (err) {
        setSaveError(err instanceof ApiError ? err.message : 'failed to save note');
      } finally {
        setSaving(false);
      }
    },
    [machineId, workingDir],
  );

  // Debounced autosave: fire ~700ms after the user stops typing. The
  // cleanup cancels an in-flight timer on each keystroke so we only
  // PUT once per pause. Skipped while loading, when nothing changed,
  // or when over the byte cap (the server would reject it anyway).
  useEffect(() => {
    if (loading || !dirty || overLimit) return;
    const id = window.setTimeout(() => void persist(text), 700);
    return () => window.clearTimeout(id);
  }, [text, dirty, overLimit, loading, persist]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-fg-tertiary">
        <Loader2 className="h-3 w-3 animate-spin" /> loading…
      </div>
    );
  }

  if (loadError) {
    return <div className="py-2 text-xs text-red-500 dark:text-red-400">{loadError}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col pb-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder="Notes for this project — TODOs, context, links, anything worth keeping next to the work."
        className="min-h-0 flex-1 resize-none rounded-md bg-surface-1/60 px-3 py-2.5 font-sans text-[13px] leading-6 text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:bg-surface-1"
      />
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span
          className={cn(
            'font-mono tabular-nums',
            overLimit ? 'text-red-500 dark:text-red-400' : 'text-fg-muted',
          )}
          title={`${byteCount.toLocaleString()} bytes used of ${PROJECT_NOTES_MAX_BYTES.toLocaleString()} byte limit`}
        >
          {text.length.toLocaleString()} / {PROJECT_NOTES_MAX_BYTES.toLocaleString()}
        </span>
        <span className="flex items-center gap-1.5">
          {overLimit ? (
            <span className="text-red-500 dark:text-red-400">too long to save</span>
          ) : saveError ? (
            <span className="inline-flex items-center gap-1 text-red-500 dark:text-red-400">
              <AlertCircle className="h-3 w-3" /> {saveError}
            </span>
          ) : saving ? (
            <span className="inline-flex items-center gap-1 text-fg-tertiary">
              <Loader2 className="h-3 w-3 animate-spin" /> saving…
            </span>
          ) : dirty ? (
            <span className="text-fg-muted">unsaved…</span>
          ) : justSaved ? (
            <span className="inline-flex items-center gap-1 text-emerald-500 dark:text-emerald-400">
              <Check className="h-3 w-3" /> saved
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
