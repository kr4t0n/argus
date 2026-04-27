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
import { useMachineStore } from '../stores/machineStore';
import { api } from '../lib/api';
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
  const iconKey = useMachineStore((s) => s.machines[machineId]?.iconKey ?? undefined);
  const Icon = resolve(iconKey);
  return <Icon className={className} />;
}

type Props = {
  machineId: string;
  className?: string;
};

/**
 * Persisted machine icon. Clicking opens a picker anchored to the
 * icon with the curated catalog above. Selection lives on the
 * Machine row server-side (`MachineDTO.iconKey`) and is broadcast
 * to every connected dashboard via `machine:upsert` — so a teammate
 * sees the same glyph the moment you pick it.
 *
 * The icon is a `<button>` (not a static glyph inside the enclosing
 * Link/Row) so it can intercept the click without triggering the
 * parent navigation — callers don't need to stopPropagation at the
 * call site.
 */
export function MachineIcon({ machineId, className }: Props) {
  const iconKey = useMachineStore((s) => s.machines[machineId]?.iconKey ?? undefined);
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
          'shrink-0 rounded-sm p-0.5 transition-colors hover:bg-surface-2/60 hover:text-fg-primary',
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
  const upsertMachine = useMachineStore((s) => s.upsert);
  const machine = useMachineStore((s) => s.machines[machineId]);
  const popRef = useRef<HTMLDivElement>(null);

  // Optimistically reflect the user's pick in the local store, then
  // persist to the server. The server will emit machine:upsert on
  // success which redundantly converges the same value — and on
  // failure we roll back the local store.
  function applyIcon(key: string) {
    if (!machine || machine.iconKey === key) {
      onClose();
      return;
    }
    const previous = machine.iconKey ?? null;
    upsertMachine({ ...machine, iconKey: key });
    onClose();
    api.setMachineIcon(machineId, key).catch((err) => {
      const current = useMachineStore.getState().machines[machineId];
      if (current) upsertMachine({ ...current, iconKey: previous });
      console.warn('failed to set machine icon', err);
    });
  }
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
      className="fixed z-50 rounded-md border border-default bg-surface-0 p-1.5 shadow-lg"
    >
      <div className="grid grid-cols-4 gap-1">
        {CATALOG_KEYS.map((key) => {
          const Icon = CATALOG[key];
          const active = key === selected;
          return (
            <button
              key={key}
              type="button"
              onClick={() => applyIcon(key)}
              title={key}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-sm transition-colors',
                active
                  ? 'bg-surface-2 text-fg-primary'
                  : 'text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary',
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
