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
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
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
    <div className="bg-neutral-950 px-4 py-3">
      <div
        className={cn(
          'surface mx-auto max-w-3xl rounded-3xl flex items-end gap-2 px-4 py-2.5',
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
          className="flex-1 resize-none bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 outline-none focus:ring-0 py-1.5"
        />
        {/* Shortcut hint sits inline next to the send button so the
            composer stays a single self-contained row instead of leaving a
            wide near-empty strip below it. */}
        <span className="hidden sm:inline text-[10px] text-neutral-600 select-none pb-2 pr-1 whitespace-nowrap">
          {running ? 'esc to cancel · shift+↵ for newline' : '↵ to send · shift+↵ for newline'}
        </span>
        {running ? (
          <Button
            size="icon"
            variant="subtle"
            onClick={onCancel}
            title="Cancel (esc)"
            className="rounded-full"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            title="Send (⏎)"
            className="rounded-full"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
