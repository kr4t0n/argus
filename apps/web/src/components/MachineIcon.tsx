import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Box,
  Cloud,
  CloudCog,
  Container,
  Cpu,
  HardDrive,
  Laptop,
  Monitor,
  Rocket,
  Server,
  ServerCog,
  Terminal,
} from 'lucide-react';
import { useUIStore } from '../stores/uiStore';
import { cn } from '../lib/utils';

type IconComponent = React.ComponentType<{ className?: string }>;

// Curated set of lucide icons that read clearly at ~12px in the
// sidebar. Keep this list small — the picker is for light
// personalization, not for indexing all of lucide.
const CATALOG: Record<string, IconComponent> = {
  server: Server,
  'server-cog': ServerCog,
  cpu: Cpu,
  'hard-drive': HardDrive,
  laptop: Laptop,
  monitor: Monitor,
  cloud: Cloud,
  'cloud-cog': CloudCog,
  container: Container,
  rocket: Rocket,
  terminal: Terminal,
  box: Box,
};

const CATALOG_KEYS = Object.keys(CATALOG);
const DEFAULT_KEY = 'server';

function resolve(key: string | undefined): IconComponent {
  if (!key) return CATALOG[DEFAULT_KEY];
  return CATALOG[key] ?? CATALOG[DEFAULT_KEY];
}

/** Read-only variant for contexts where the whole row is clickable
 *  (e.g. the collapsed sidebar rail) — no picker, no click handler. */
export function MachineIconGlyph({
  machineId,
  className,
}: {
  machineId: string;
  className?: string;
}) {
  const iconKey = useUIStore((s) => s.machineIcons[machineId]);
  const Icon = resolve(iconKey);
  return <Icon className={className} />;
}

type Props = {
  machineId: string;
  className?: string;
};

/**
 * Persisted machine icon. Clicking opens a picker anchored to the
 * icon with the curated catalog above. Selection is stored per
 * machine in localStorage via the Zustand `uiStore.machineIcons` map.
 *
 * The icon is a `<button>` (not a static glyph inside the enclosing
 * Link/Row) so it can intercept the click without triggering the
 * parent navigation — callers don't need to stopPropagation at the
 * call site.
 */
export function MachineIcon({ machineId, className }: Props) {
  const iconKey = useUIStore((s) => s.machineIcons[machineId]);
  const Icon = resolve(iconKey);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="change icon"
        className={cn(
          'shrink-0 rounded-sm p-0.5 transition-colors hover:bg-neutral-800/60 hover:text-neutral-200',
          className,
        )}
      >
        <Icon className="h-3 w-3" />
      </button>
      {open && (
        <MachineIconPicker
          machineId={machineId}
          selected={iconKey ?? DEFAULT_KEY}
          anchor={anchorRef}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

const POPOVER_WIDTH = 160;
const VIEWPORT_MARGIN = 8;

function MachineIconPicker({
  machineId,
  selected,
  anchor,
  onClose,
}: {
  machineId: string;
  selected: string;
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const setMachineIcon = useUIStore((s) => s.setMachineIcon);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    function place() {
      const a = anchor.current;
      const pop = popRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const popH = pop?.offsetHeight ?? 0;
      // Float right of the anchor; flip to left if the right edge
      // would clip the viewport.
      let left = rect.right + 6;
      if (left + POPOVER_WIDTH + VIEWPORT_MARGIN > window.innerWidth) {
        left = Math.max(VIEWPORT_MARGIN, rect.left - POPOVER_WIDTH - 6);
      }
      let top = rect.top;
      if (popH && top + popH + VIEWPORT_MARGIN > window.innerHeight) {
        top = Math.max(VIEWPORT_MARGIN, window.innerHeight - popH - VIEWPORT_MARGIN);
      }
      setPos({ top, left });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);

  // Dismiss on outside click / Esc.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const pop = popRef.current;
      const a = anchor.current;
      const t = e.target as Node;
      if (pop?.contains(t) || a?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={popRef}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: POPOVER_WIDTH,
      }}
      className="fixed z-50 rounded-md border border-neutral-800 bg-neutral-950 p-1.5 shadow-lg"
    >
      <div className="grid grid-cols-4 gap-1">
        {CATALOG_KEYS.map((key) => {
          const Icon = CATALOG[key];
          const active = key === selected;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                setMachineIcon(machineId, key);
                onClose();
              }}
              title={key}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-sm transition-colors',
                active
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
