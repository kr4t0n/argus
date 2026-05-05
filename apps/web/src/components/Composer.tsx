import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from './ui/Button';
import { cn } from '../lib/utils';

type Props = {
  disabled?: boolean;
  running?: boolean;
  placeholder?: string;
  onSend: (prompt: string) => void | Promise<void>;
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
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, [value]);

  async function handleSend() {
    if (!value.trim() || disabled || running) return;
    const prompt = value.trim();
    setValue('');
    onChange?.('');
    await onSend(prompt);
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
        className={cn(
          'mx-auto max-w-3xl flex items-end gap-2 rounded-3xl bg-surface-1/60 pl-6 pr-3 py-3 transition-colors dark:bg-surface-2/60',
          'focus-within:bg-surface-1 dark:focus-within:bg-surface-2',
          disabled && 'opacity-50',
        )}
      >
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            onChange?.(e.target.value);
          }}
          onKeyDown={onKeyDown}
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
            disabled={!value.trim() || disabled}
            title="Send (⏎)"
            aria-label="Send message"
            className="rounded-full"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </Button>
        )}
      </div>
    </div>
  );
}
