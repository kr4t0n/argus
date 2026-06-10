import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface SelectOption {
  value: string;
  label: string;
  /** Dim right-aligned annotation, e.g. "CLI default". */
  hint?: string;
}

/**
 * Custom listbox styled after the app's dropdown menus (see the
 * Sidebar's "update all" menu): input-like trigger, `bg-surface-0`
 * panel with `hover:bg-surface-1` rows, check mark on the selected
 * row. Replaces native `<select>`, which fights the theme — the OS
 * paints its own popup chrome.
 *
 * Keyboard: Enter/Space/ArrowDown open; arrows move the highlight;
 * Enter selects; Escape closes. Outside click closes. The panel caps
 * at ~16 rows and scrolls (cursor catalogs have ~20 families).
 */
export function Select({
  value,
  options,
  onChange,
  className,
  title,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Open with the selected row highlighted and scrolled into view.
  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setHighlight(idx);
    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, [open, options, value]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        // Don't let a parent popover's Escape handler also fire.
        e.stopPropagation();
        setOpen(false);
        break;
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const next = Math.min(Math.max(highlight + dir, 0), options.length - 1);
        setHighlight(next);
        panelRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'Enter':
        e.preventDefault();
        if (highlight >= 0 && options[highlight]) {
          onChange(options[highlight].value);
          setOpen(false);
        }
        break;
    }
  }

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        title={title}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md bg-surface-2/40 px-3 py-2 text-left text-xs transition-colors',
          'text-fg-primary hover:bg-surface-2/60 focus:bg-surface-2 focus:outline-none',
        )}
      >
        <span className="truncate">{selected?.label ?? '—'}</span>
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-fg-muted transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div
          ref={panelRef}
          role="listbox"
          // Partial guard against <label> click forwarding: inside a
          // <label>, an option-row click (target = inner <span>) gets
          // re-dispatched by the label onto its first labelable
          // descendant — our trigger — toggling the panel back open.
          // stopPropagation blocks that in Blink only; WebKit runs
          // label activation as the event's default action regardless
          // of propagation. So the REAL rule is: never render this
          // component inside a <label> (see CreateAgentPopover's
          // Field as="div"). This handler stays as cheap extra cover
          // for Blink if a label ever sneaks back in.
          onClick={(e) => e.stopPropagation()}
          // min-w-full w-max: the panel is at least as wide as the
          // trigger but grows to fit option labels — narrow triggers
          // (the effort select sharing a row) keep readable panels.
          className="absolute left-0 top-full z-50 mt-1 max-h-64 w-max min-w-full max-w-72 overflow-y-auto rounded-md border border-default bg-surface-0 py-1 shadow-lg"
        >
          {options.map((o, i) => {
            const isSelected = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected || undefined}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  isSelected ? 'text-fg-primary' : 'text-fg-secondary',
                  i === highlight && 'bg-surface-1',
                )}
              >
                <Check
                  className={cn('h-3 w-3 shrink-0', isSelected ? 'opacity-100' : 'opacity-0')}
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-meta">{o.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
