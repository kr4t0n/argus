import { useEffect, useRef, useState } from 'react';
import { Check, ListChecks, Paperclip, Pencil, X } from 'lucide-react';
import { useQueueStore, type QueuedPrompt } from '../stores/queueStore';
import { cn } from '../lib/utils';

const EMPTY: QueuedPrompt[] = [];

/**
 * The small stack of pending prompts shown directly above the Composer
 * while a turn is running. Items flush FIFO from `SessionPanel` as the
 * session goes idle; here the user can re-order their plans by editing
 * the text inline or removing entries before they're sent.
 */
export function PromptQueue({ sessionId }: { sessionId: string }) {
  const queue = useQueueStore((s) => s.queues[sessionId] ?? EMPTY);
  const updatePrompt = useQueueStore((s) => s.updatePrompt);
  const remove = useQueueStore((s) => s.remove);
  const clear = useQueueStore((s) => s.clear);

  if (queue.length === 0) return null;

  return (
    <div className="mx-auto mb-2 max-w-3xl">
      <div className="mb-1.5 flex items-center gap-1.5 px-2 text-xs text-fg-tertiary">
        <ListChecks className="h-3.5 w-3.5" />
        <span>
          Queued · {queue.length} {queue.length === 1 ? 'message' : 'messages'}
        </span>
        <button
          onClick={() => clear(sessionId)}
          className="ml-auto rounded px-1 py-0.5 text-fg-tertiary transition-colors hover:text-fg-primary"
          title="Clear the queue"
        >
          Clear all
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {queue.map((item, i) => (
          <QueueRow
            key={item.id}
            index={i}
            item={item}
            onSave={(v) => updatePrompt(sessionId, item.id, v)}
            onRemove={() => remove(sessionId, item.id)}
          />
        ))}
      </div>
    </div>
  );
}

function QueueRow({
  index,
  item,
  onSave,
  onRemove,
}: {
  index: number;
  item: QueuedPrompt;
  onSave: (prompt: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.prompt);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Keep the draft in sync if the item's text changes underneath us
  // (e.g. it was edited in another tab and rehydrated).
  useEffect(() => {
    if (!editing) setDraft(item.prompt);
  }, [item.prompt, editing]);

  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [editing]);

  function commit() {
    const next = draft.trim();
    // An item with neither text nor attachments has nothing left to
    // send — drop it rather than queue an empty turn.
    if (!next && item.attachments.length === 0) {
      onRemove();
      return;
    }
    onSave(next);
    setEditing(false);
  }

  function cancel() {
    setDraft(item.prompt);
    setEditing(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  return (
    <div
      className={cn(
        'group flex items-start gap-2 rounded-2xl border border-default/60 bg-surface-1/60 px-3 py-2 dark:bg-surface-2/40',
        editing && 'border-primary/50',
      )}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2/70 text-[11px] font-medium tabular-nums text-fg-tertiary">
        {index + 1}
      </span>

      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              const ta = e.target;
              ta.style.height = 'auto';
              ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
            }}
            onKeyDown={onKeyDown}
            onBlur={commit}
            rows={1}
            aria-label="Edit queued message"
            className="w-full resize-none bg-transparent text-sm text-fg-primary outline-none focus:ring-0 no-scrollbar"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Click to edit"
            className="block w-full cursor-text text-left text-sm text-fg-secondary"
          >
            {item.prompt.trim() ? (
              <span className="line-clamp-3 whitespace-pre-wrap break-words">{item.prompt}</span>
            ) : (
              <span className="italic text-fg-muted">(no message)</span>
            )}
          </button>
        )}

        {item.attachments.length > 0 && (
          <div className="mt-1 flex items-center gap-1 text-xs text-fg-tertiary">
            <Paperclip className="h-3 w-3" />
            <span>
              {item.attachments.length}{' '}
              {item.attachments.length === 1 ? 'attachment' : 'attachments'}
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {editing ? (
          <button
            onMouseDown={(e) => e.preventDefault() /* keep focus → commit, not blur-cancel */}
            onClick={commit}
            title="Save (⏎)"
            aria-label="Save edit"
            className="rounded-md p-1 text-fg-tertiary transition-colors hover:bg-surface-2/60 hover:text-fg-primary"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            onClick={() => setEditing(true)}
            title="Edit"
            aria-label="Edit queued message"
            className="rounded-md p-1 text-fg-tertiary opacity-0 transition-opacity hover:bg-surface-2/60 hover:text-fg-primary group-hover:opacity-100"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={onRemove}
          title="Remove from queue"
          aria-label="Remove from queue"
          className="rounded-md p-1 text-fg-tertiary transition-colors hover:bg-surface-2/60 hover:text-fg-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
