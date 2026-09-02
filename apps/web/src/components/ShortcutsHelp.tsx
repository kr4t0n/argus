import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Keyboard } from 'lucide-react';
import { usePaletteStore } from '../stores/paletteStore';
import { useGlobalHotkey } from '../lib/useGlobalHotkey';
import { HOTKEYS, LOCAL_KEYS } from '../lib/hotkeys';
import { Kbd } from './ui/Kbd';

/**
 * The ⌘/ shortcuts overlay.
 *
 * Every binding this app has was previously discoverable only by already
 * knowing it — the palette's footer hints are visible only once you've
 * opened the palette, and a tooltip requires hovering the exact control.
 * This is the one surface that answers "what can I press" cold.
 *
 * It reads `lib/hotkeys.ts` rather than a hand-written list, so a binding
 * cannot ship without appearing here: `useGlobalHotkey` takes a
 * `HotkeyBinding`, and every `HotkeyBinding` lives in the table this
 * renders. The context-local keys (`LOCAL_KEYS`) are appended because a
 * user asking the question does not care which layer owns the handler.
 *
 * Open-state rides `paletteStore.mode` — see the note there on why three
 * overlays share one field. Portal + Escape + body-scroll-lock mirrors
 * `CommandPalette`, which in turn mirrors `ImageLightbox`.
 */

/** Built once at module scope — the registry is a constant. `Anywhere`
 *  vs `In a session` is the `scope` field made legible: a session binding
 *  is registered in `SessionPanel` and genuinely does nothing on
 *  `/machines/:id` or `/user`. */
const GROUPS: ReadonlyArray<{
  title: string;
  keys: ReadonlyArray<{ chord: string; label: string }>;
}> = [
  {
    title: 'Anywhere',
    keys: Object.values(HOTKEYS).filter((b) => b.scope === 'global'),
  },
  {
    title: 'In a session',
    keys: Object.values(HOTKEYS).filter((b) => b.scope === 'session'),
  },
  ...LOCAL_KEYS,
];

export function ShortcutsHelp() {
  const mode = usePaletteStore((s) => s.mode);
  const toggle = usePaletteStore((s) => s.toggle);
  const close = usePaletteStore((s) => s.close);

  useGlobalHotkey(HOTKEYS.shortcutsHelp, () => toggle('help'));

  const open = mode === 'help';

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onMouseDown={close}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh] animate-in fade-in duration-100"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-default bg-surface-0 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-default px-4 py-3">
          <Keyboard size={15} className="shrink-0 text-fg-muted" />
          <span className="text-sm font-medium text-fg-primary">Keyboard shortcuts</span>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-1">
          {GROUPS.map((group) => (
            <section key={group.title} className="py-3">
              <h3 className="pb-1.5 text-[11px] uppercase tracking-wide text-fg-muted">
                {group.title}
              </h3>
              <dl className="divide-y divide-default/50">
                {group.keys.map((k) => (
                  <div key={k.chord + k.label} className="flex items-center gap-4 py-1.5">
                    <dt className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
                      {k.label}
                    </dt>
                    <dd className="shrink-0">
                      <Kbd>{k.chord}</Kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="border-t border-default px-4 py-1.5 text-[11px] text-fg-muted">
          <Kbd>esc</Kbd> close · the <Kbd>ctrl</Kbd> form of any binding above defers to the
          shell while the terminal has focus
        </div>
      </div>
    </div>,
    document.body,
  );
}
