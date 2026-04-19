import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import type { AvailableAdapter, MachineDTO } from '@argus/shared-types';
import { api, ApiError } from '../lib/api';
import { useAgentStore } from '../stores/agentStore';
import { agentTypeLabel, AgentTypeIcon } from './ui/AgentTypeIcon';
import { cn } from '../lib/utils';

/**
 * Floating "create agent" form anchored to a machine row in the
 * sidebar. Rendered through a portal positioned by the row's
 * bounding rect so the popover escapes the sidebar's overflow
 * container — the machine list is bottom-pinned with its own
 * `overflow-y-auto`, which otherwise clips a popover that pops
 * "above" the row.
 *
 * Placement: the popover floats to the right of the sidebar (so it
 * doesn't overlap the row itself), vertically aligned with the row's
 * top, then nudged up if it would otherwise overflow the viewport.
 *
 * The adapter picker is rendered as a row of icon buttons (one per
 * adapter the sidecar actually discovered on the host via
 * `machine.availableAdapters`) — clicking one selects it, similar
 * to a segmented control. We previously used a `<select>` dropdown
 * but a flat picker is faster (one click vs. open + scan + click)
 * and reads better at the popover's narrow width. If the machine
 * reported no adapters at all we still expose a free-form text
 * input as an escape hatch — useful for debugging and forward-compat
 * with custom adapters.
 */
type Props = {
  machine: MachineDTO;
  /** The row the popover is anchored to; used for positioning. */
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
};

const POPOVER_WIDTH = 288;        // 18rem (Tailwind w-72)
const VIEWPORT_MARGIN = 8;        // keep this far from the edge

export function CreateAgentPopover({ machine, anchor, onClose }: Props) {
  const upsertAgent = useAgentStore((s) => s.upsert);
  const adapters = (machine.availableAdapters ?? []) as AvailableAdapter[];
  const defaultType = adapters[0]?.type ?? '';

  const [type, setType] = useState<string>(defaultType);
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [supportsTerminal, setSupportsTerminal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position the portal relative to the anchor row. Recomputes on
  // mount, on window resize, and after the popover renders (so we
  // know its true height for the bottom-edge clamp). We keep this in
  // a layout effect so the first paint is already in the right spot.
  useLayoutEffect(() => {
    function place() {
      const a = anchor.current;
      const pop = popRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const popH = pop?.offsetHeight ?? 0;
      // Float to the right edge of the anchor row, with a small gap.
      let left = rect.right + 8;
      // Fall back to "left of the anchor" if the popover would clip
      // the right edge of the viewport.
      if (left + POPOVER_WIDTH + VIEWPORT_MARGIN > window.innerWidth) {
        left = Math.max(VIEWPORT_MARGIN, rect.left - POPOVER_WIDTH - 8);
      }
      // Vertically: align top with the row, but never let the bottom
      // run off-screen — pull it up if needed (and never above the
      // top margin).
      let top = rect.top;
      if (popH && top + popH + VIEWPORT_MARGIN > window.innerHeight) {
        top = Math.max(VIEWPORT_MARGIN, window.innerHeight - popH - VIEWPORT_MARGIN);
      }
      setPos({ top, left });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onDown(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKey);
    // Defer mousedown listener by a tick so the click that opened us
    // doesn't immediately close us.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const canSubmit =
    !!type.trim() && !!name.trim() && !submitting && machine.status === 'online';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      const created = await api.createAgent(machine.id, {
        name: name.trim(),
        type,
        workingDir: workingDir.trim() || undefined,
        supportsTerminal,
      });
      upsertAgent(created);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'failed to create agent');
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      ref={popRef}
      className="fixed z-[60] rounded-lg border border-neutral-800 p-3 shadow-2xl"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: POPOVER_WIDTH,
        backgroundColor: '#101012',
        // Hide until we've measured so the user doesn't see a flash
        // of the popover at the (-9999, -9999) staging coords.
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="dialog"
      aria-label={`Create agent on ${machine.name}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-widest text-neutral-500">
          new agent on{' '}
          <span className="text-neutral-300 normal-case tracking-normal">
            {machine.name}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-neutral-600 hover:text-neutral-300"
          title="close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {machine.status === 'offline' && (
        <div className="mb-2 rounded bg-neutral-900 px-2 py-1.5 text-[11px] text-amber-300">
          this machine is offline; the agent will queue and start when the sidecar reconnects
        </div>
      )}
      {adapters.length === 0 && (
        <div className="mb-2 rounded bg-neutral-900 px-2 py-1.5 text-[11px] text-neutral-400">
          sidecar reported no installed adapters; you can still try a known type
        </div>
      )}

      <form onSubmit={submit} className="space-y-2">
        <Field label="adapter">
          {adapters.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {adapters.map((a) => {
                  const selected = a.type === type;
                  return (
                    <button
                      key={a.type}
                      type="button"
                      onClick={() => setType(a.type)}
                      title={a.version ? `${agentTypeLabel(a.type)} · ${a.version}` : agentTypeLabel(a.type)}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs ring-1 transition-colors',
                        selected
                          ? 'bg-neutral-800 text-neutral-100 ring-neutral-600'
                          : 'bg-neutral-900 text-neutral-400 ring-neutral-800 hover:bg-neutral-800/70 hover:text-neutral-200',
                      )}
                    >
                      <AgentTypeIcon type={a.type} />
                      <span>{agentTypeLabel(a.type)}</span>
                    </button>
                  );
                })}
              </div>
              {type && (
                <div className="mt-1 text-[11px] text-neutral-500">
                  {adapters.find((a) => a.type === type)?.version ?? ''}
                </div>
              )}
            </>
          ) : (
            <>
              <input
                value={type}
                onChange={(e) => setType(e.target.value)}
                placeholder="claude-code, codex, cursor-cli, …"
                className="w-full rounded bg-neutral-900 px-2 py-1.5 font-mono text-xs text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
              />
              {type && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500">
                  <AgentTypeIcon type={type} />
                  <span>{agentTypeLabel(type)}</span>
                </div>
              )}
            </>
          )}
        </Field>

        <Field label="name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="api-bot, frontend, …"
            autoFocus
            className="w-full rounded bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
          />
        </Field>

        <Field label="working dir (optional)">
          <input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/Users/you/projects/foo"
            className="w-full rounded bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 focus:ring-neutral-600"
          />
        </Field>

        <label className="flex items-center gap-2 px-0.5 py-1 text-xs text-neutral-300 cursor-pointer">
          <input
            type="checkbox"
            checked={supportsTerminal}
            onChange={(e) => setSupportsTerminal(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
          attach interactive terminal
        </label>

        {err && (
          <div className="rounded bg-red-950/40 px-2 py-1.5 text-[11px] text-red-300">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2.5 py-1 text-xs text-neutral-400 hover:text-neutral-200"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs',
              canSubmit
                ? 'bg-emerald-500 text-neutral-950 hover:bg-emerald-400'
                : 'bg-neutral-800 text-neutral-500',
            )}
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
            create
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}
