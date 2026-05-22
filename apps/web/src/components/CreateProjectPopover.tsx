import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import type { MachineDTO } from '@argus/shared-types';
import { useProjectStore, projectKey } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { cn } from '../lib/utils';

/**
 * Floating "create project" form anchored to a machine row in the
 * sidebar. Mirrors CreateAgentPopover's positioning + dismiss logic
 * (portal, edge clamps, escape/outside-click close) but creates a
 * client-only project placeholder via useProjectStore rather than
 * calling the server — the sidebar's project tree merges placeholders
 * with agent-derived projects. Agents for the project are created
 * later from the project row's hover `+`.
 */
type Props = {
  machine: MachineDTO;
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
};

const POPOVER_WIDTH = 288;
const VIEWPORT_MARGIN = 8;

export function CreateProjectPopover({ machine, anchor, onClose }: Props) {
  const addProject = useProjectStore((s) => s.add);
  const setExpanded = useUIStore((s) => s.toggleAgentExpanded);

  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [supportsTerminal, setSupportsTerminal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    function place() {
      const a = anchor.current;
      const pop = popRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const popH = pop?.offsetHeight ?? 0;
      let left = rect.right + 8;
      if (left + POPOVER_WIDTH + VIEWPORT_MARGIN > window.innerWidth) {
        left = Math.max(VIEWPORT_MARGIN, rect.left - POPOVER_WIDTH - 8);
      }
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
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const canSubmit = !!name.trim() && !!workingDir.trim() && !submitting;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      const created = addProject({
        machineId: machine.id,
        name: name.trim(),
        workingDir: workingDir.trim(),
        supportsTerminal,
      });
      // Force-open the project row so the user lands on a visible,
      // expanded project and can immediately click its `+` to add an
      // agent. The `expanded` map's default-open semantics aren't
      // enough — a previously-closed key would stay closed otherwise.
      setExpanded(`proj:${projectKey(created.machineId, created.workingDir)}`, true);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed to create project');
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div
      ref={popRef}
      className="fixed z-[60] rounded-lg border border-default bg-surface-0 p-5 shadow-2xl"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: POPOVER_WIDTH,
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="dialog"
      aria-label={`Create project on ${machine.name}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="text-caps">
          new project on{' '}
          <span className="text-fg-secondary normal-case tracking-normal text-xs font-normal">
            {machine.name}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-fg-muted hover:text-fg-secondary"
          title="close"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Field label="name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="frontend, api, …"
            autoFocus
            className="w-full rounded-md bg-surface-2/40 px-3 py-2 text-sm text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:bg-surface-2"
          />
        </Field>

        <Field label="working dir">
          <input
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            placeholder="/Users/you/projects/foo"
            className="w-full rounded-md bg-surface-2/40 px-3 py-2 font-mono text-xs text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:bg-surface-2"
          />
        </Field>

        <label className="flex items-center gap-2 px-0.5 py-1 text-xs text-fg-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={supportsTerminal}
            onChange={(e) => setSupportsTerminal(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
          attach interactive terminal
        </label>

        {err && (
          <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2.5 py-1 text-xs text-fg-tertiary hover:text-fg-primary"
          >
            cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium tracking-tight transition-colors',
              canSubmit
                ? 'bg-primary text-primary-fg hover:bg-primary-hover'
                : 'bg-surface-2 text-fg-tertiary',
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
      <span className="mb-1 block text-caps">{label}</span>
      {children}
    </label>
  );
}
