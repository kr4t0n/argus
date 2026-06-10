import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Paperclip, X, FileText, Loader2, AlertCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { ImageLightbox } from './ImageLightbox';
import { cn } from '../lib/utils';
import { api } from '../lib/api';

type PendingAttachment = {
  localId: string;
  name: string;
  mime: string;
  status: 'uploading' | 'done' | 'error';
  /** Server attachment id, set once the upload resolves. */
  id?: string;
  /** Object URL for an instant local image thumbnail (revoked on remove). */
  previewUrl?: string;
};

let localSeq = 0;

type Props = {
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
  onSend: (prompt: string, attachmentIds: string[]) => void | Promise<void>;
  onCancel?: () => void;
  initial?: string;
  onChange?: (v: string) => void;
};

export function Composer({
  disabled,
  running,
  placeholder,
  onSend,
  onCancel,
  initial = '',
  onChange,
}: Props) {
  const [value, setValue] = useState(initial);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [value]);

  // Revoke any outstanding object URLs when the composer unmounts.
  useEffect(() => {
    return () => {
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploading = attachments.some((a) => a.status === 'uploading');
  const doneIds = attachments.filter((a) => a.status === 'done' && a.id).map((a) => a.id as string);
  const canSend = !disabled && !uploading && (!!value.trim() || doneIds.length > 0);

  function addFiles(files: File[]) {
    if (disabled) return;
    for (const file of files) {
      const localId = `a${++localSeq}`;
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      setAttachments((prev) => [
        ...prev,
        { localId, name: file.name, mime: file.type, status: 'uploading', previewUrl },
      ]);
      api
        .uploadAttachment(file)
        .then((dto) =>
          setAttachments((prev) =>
            prev.map((a) => (a.localId === localId ? { ...a, status: 'done', id: dto.id } : a)),
          ),
        )
        .catch(() =>
          setAttachments((prev) =>
            prev.map((a) => (a.localId === localId ? { ...a, status: 'error' } : a)),
          ),
        );
    }
  }

  function removeAttachment(localId: string) {
    setAttachments((prev) => {
      const hit = prev.find((a) => a.localId === localId);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((a) => a.localId !== localId);
    });
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = ''; // allow re-selecting the same file
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) addFiles(files);
  }

  async function handleSend() {
    if (!canSend || running) return;
    const prompt = value.trim();
    const ids = doneIds;
    // Optimistic clear (matches the prior text-only behavior). Uploaded
    // files persist server-side, so a failed send doesn't lose the bytes.
    setValue('');
    onChange?.('');
    attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    await onSend(prompt, ids);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && running && onCancel) {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="bg-surface-0 px-6 pt-4 pb-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'mx-auto max-w-3xl rounded-3xl bg-surface-1/60 transition-colors dark:bg-surface-2/60',
          'focus-within:bg-surface-1 dark:focus-within:bg-surface-2',
          dragOver && 'ring-2 ring-primary ring-offset-0',
          disabled && 'opacity-50',
        )}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-5 pt-3">
            {attachments.map((a) => (
              <AttachmentChip key={a.localId} a={a} onRemove={removeAttachment} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 pl-3 pr-3 py-2">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            title="Attach files"
            aria-label="Attach files"
            className="rounded-full text-fg-tertiary hover:text-fg-primary"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              onChange?.(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={placeholder ?? 'Request changes or ask a question…'}
            disabled={disabled}
            rows={1}
            aria-label="Send a message"
            className="flex-1 resize-none bg-transparent text-sm text-fg-primary placeholder:text-fg-muted outline-none focus:ring-0 py-1.5 no-scrollbar"
          />
          {running ? (
            <Button
              size="icon"
              variant="subtle"
              onClick={onCancel}
              title="Cancel (esc)"
              aria-label="Cancel running command"
              className="rounded-full"
            >
              <Square className="h-3 w-3" strokeWidth={2.5} fill="currentColor" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!canSend}
              title={uploading ? 'Waiting for uploads…' : 'Send (⏎)'}
              aria-label="Send message"
              className="rounded-full"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              )}
            </Button>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={onPickFiles}
        aria-hidden="true"
      />
    </div>
  );
}

function AttachmentChip({
  a,
  onRemove,
}: {
  a: PendingAttachment;
  onRemove: (localId: string) => void;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  return (
    <div className="group relative">
      {a.previewUrl ? (
        <button
          type="button"
          onDoubleClick={() => setLightboxOpen(true)}
          title={`Double-click to preview ${a.name}`}
          aria-label={`Preview ${a.name}`}
          className="block cursor-zoom-in overflow-hidden rounded-lg border border-default focus:outline-none focus-visible:ring-2 focus-visible:ring-fg-tertiary"
        >
          <img src={a.previewUrl} alt={a.name} className="h-14 w-14 object-cover" />
        </button>
      ) : (
        <div className="flex h-14 w-36 items-center gap-2 rounded-lg border border-default bg-surface-1 px-2 dark:bg-surface-2">
          <FileText className="h-4 w-4 shrink-0 text-fg-tertiary" />
          <span className="truncate text-xs text-fg-secondary">{a.name}</span>
        </div>
      )}
      {/* Status overlays are pointer-events-none so a click still reaches
          the thumbnail button underneath (preview works mid-upload). */}
      {a.status === 'uploading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
          <Loader2 className="h-4 w-4 animate-spin text-white" />
        </div>
      )}
      {a.status === 'error' && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-red-500/50"
          title="upload failed"
        >
          <AlertCircle className="h-4 w-4 text-white" />
        </div>
      )}
      <button
        onClick={() => onRemove(a.localId)}
        title="Remove"
        aria-label={`Remove ${a.name}`}
        className="absolute -right-1.5 -top-1.5 rounded-full bg-surface-2 p-0.5 text-fg-secondary opacity-0 shadow transition-opacity hover:text-fg-primary group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
      {lightboxOpen && a.previewUrl && (
        <ImageLightbox src={a.previewUrl} alt={a.name} onClose={() => setLightboxOpen(false)} />
      )}
    </div>
  );
}
