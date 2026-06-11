import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Loader2, X } from 'lucide-react';
import type { AgentDTO, AvailableAdapter, MachineDTO, ModelSelection } from '@argus/shared-types';
import { api, ApiError } from '../lib/api';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { agentTypeLabel, AgentTypeIcon } from './ui/AgentTypeIcon';
import { ModelPicker } from './ModelPicker';
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
  /**
   * Prefill values for workingDir and the terminal toggle. In agent
   * mode they prefill the form fields (still editable); in
   * `asSession` mode the fields are hidden and these values are used
   * silently at agent creation time.
   */
  defaults?: {
    workingDir?: string;
    supportsTerminal?: boolean;
  };
  /**
   * Switches the popover from "create agent" to "create session":
   *  - title + name label flip to session terminology
   *  - workingDir + terminal inputs vanish (values from `defaults`)
   *  - submit auto-vivifies a project-scoped agent (reuses an
   *    `existingAgents` entry of the chosen type, creates one with
   *    an auto-generated name if none exists), then creates a session
   *    titled with the user's input, then navigates to it
   * `MachinePanel` keeps the default (agent mode) for raw agent
   * creation; only `ProjectRow` flips this on.
   */
  asSession?: boolean;
  /**
   * Existing agents in the project context. Used by `asSession` mode
   * to look up a same-type agent to reuse before creating a new one.
   * Empty/omitted in agent mode.
   */
  existingAgents?: AgentDTO[];
};

// Sized so (a) the model picker's model + effort/variant + facet
// chips and (b) the three built-in adapter chips each fit on one row.
// Keep in sync with CreateProjectPopover so the two creation surfaces
// read as siblings. The rendered width is additionally clamped to the
// viewport via maxWidth (placement math may then overestimate on tiny
// screens, which only makes the left-side fallback trigger early —
// harmless).
const POPOVER_WIDTH = 352;
const VIEWPORT_MARGIN = 8; // keep this far from the edge

export function CreateAgentPopover({
  machine,
  anchor,
  onClose,
  defaults,
  asSession = false,
  existingAgents,
}: Props) {
  const upsertAgent = useAgentStore((s) => s.upsert);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const nav = useNavigate();
  const adapters = (machine.availableAdapters ?? []) as AvailableAdapter[];
  const defaultType = adapters[0]?.type ?? '';

  const [type, setType] = useState<string>(defaultType);
  const [name, setName] = useState('');
  const [workingDir, setWorkingDir] = useState(defaults?.workingDir ?? '');
  const [supportsTerminal, setSupportsTerminal] = useState(defaults?.supportsTerminal ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Per-adapter model choice, keyed by adapter type so flipping
  // Claude Code → Codex → back doesn't lose the Claude selection.
  // Session mode only; agent creation doesn't carry a model default.
  const [modelByType, setModelByType] = useState<Record<string, ModelSelection | null>>({});
  const modelSelection = modelByType[type] ?? null;
  // The catalog needs an existing agent of the chosen type. For the
  // project's first session on an adapter there is none yet (the agent
  // is auto-vivified on submit) — the picker degrades to a free-text
  // input in that case, by design.
  const catalogAgentId = asSession
    ? ((existingAgents ?? []).find((a) => a.type === type)?.id ?? null)
    : null;
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
    // Re-place when the popover's own size changes — e.g. the error
    // block appearing after a failed submit. setPos updates top/left,
    // not size, so this can't loop.
    const pop = popRef.current;
    const observer = pop ? new ResizeObserver(() => place()) : null;
    if (observer && pop) observer.observe(pop);
    // Capture-phase so scrolls of any ancestor container reposition
    // us — but scrolls INSIDE the popover (the model dropdown's
    // option list) don't move the anchor, and repositioning on them
    // re-renders the tree mid-scroll. Skip those.
    function onScroll(e: Event) {
      if (popRef.current && e.target instanceof Node && popRef.current.contains(e.target)) {
        return;
      }
      place();
    }
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
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

  const canSubmit = !!type.trim() && !!name.trim() && !submitting && machine.status === 'online';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      if (asSession) {
        // Auto-vivify: reuse an existing same-type agent in this
        // project if one's there, otherwise stand a new one up with
        // an auto-generated name (the user named the session, not
        // the agent — the agent is hidden in this flow).
        const reuse = (existingAgents ?? []).find((a) => a.type === type);
        let agentId: string;
        if (reuse) {
          agentId = reuse.id;
        } else {
          const created = await api.createAgent(machine.id, {
            name: `${type}-${Math.random().toString(16).slice(2, 8)}`,
            type,
            workingDir: defaults?.workingDir,
            supportsTerminal: defaults?.supportsTerminal ?? false,
          });
          upsertAgent(created);
          agentId = created.id;
        }
        // Empty custom input ({model: ''}) normalizes to "Default".
        const selection = modelSelection?.model ? modelSelection : undefined;
        const { session } = await api.createSession({
          agentId,
          title: name.trim(),
          modelSelection: selection,
        });
        upsertSession(session);
        nav(`/sessions/${session.id}`);
        onClose();
      } else {
        const created = await api.createAgent(machine.id, {
          name: name.trim(),
          type,
          workingDir: workingDir.trim() || undefined,
          supportsTerminal,
        });
        upsertAgent(created);
        onClose();
      }
    } catch (e) {
      setErr(
        e instanceof ApiError ? e.message : `failed to create ${asSession ? 'session' : 'agent'}`,
      );
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
        maxWidth: 'calc(100vw - 16px)',
        // Hide until we've measured so the user doesn't see a flash
        // of the popover at the (-9999, -9999) staging coords.
        visibility: pos ? 'visible' : 'hidden',
      }}
      role="dialog"
      aria-label={asSession ? 'Create session' : `Create agent on ${machine.name}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="text-caps">
          {asSession ? (
            <>new session</>
          ) : (
            <>
              new agent on{' '}
              <span className="text-fg-secondary normal-case tracking-normal text-xs font-normal">
                {machine.name}
              </span>
            </>
          )}
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

      {machine.status === 'offline' && (
        <div className="mb-3 rounded-md bg-surface-2/40 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
          this machine is offline; the {asSession ? 'session' : 'agent'} will queue and start
          when the sidecar reconnects
        </div>
      )}
      {adapters.length === 0 && (
        <div className="mb-3 rounded-md bg-surface-2/40 px-3 py-2 text-xs text-fg-tertiary">
          sidecar reported no installed adapters; you can still try a known type
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        {/* as="div" for the same reason as the model field below: a
            <label> implicitly associates with its FIRST labelable
            descendant (the first adapter chip), so hovering anywhere
            in the field lit up that chip's hover style and clicking
            empty space selected it. */}
        <Field label="adapter" as="div">
          {adapters.length > 0 ? (
            <>
              {/* gap-1/px-2 (vs the usual 1.5/2.5) so the three
                  built-in adapters stay on one row at POPOVER_WIDTH;
                  wrap remains the fallback for machines reporting
                  more (custom) adapters. */}
              <div className="flex flex-wrap gap-1">
                {adapters.map((a) => {
                  const selected = a.type === type;
                  return (
                    <button
                      key={a.type}
                      type="button"
                      onClick={() => setType(a.type)}
                      title={
                        a.version
                          ? `${agentTypeLabel(a.type)} · ${a.version}`
                          : agentTypeLabel(a.type)
                      }
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors',
                        selected
                          ? 'bg-surface-2 text-fg-primary'
                          : 'bg-transparent text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-primary',
                      )}
                    >
                      <AgentTypeIcon type={a.type} />
                      <span>{agentTypeLabel(a.type)}</span>
                    </button>
                  );
                })}
              </div>
              {type && (
                <div className="mt-1 text-meta font-mono">
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
                className="w-full rounded-md bg-surface-2/40 px-3 py-2 font-mono text-xs text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:bg-surface-2"
              />
              {type && (
                <div className="mt-1 flex items-center gap-1.5 text-meta">
                  <AgentTypeIcon type={type} />
                  <span>{agentTypeLabel(type)}</span>
                </div>
              )}
            </>
          )}
        </Field>

        {/* as="div": the picker embeds its own interactive controls
            (listbox trigger, options, toggles). Inside a <label>,
            WebKit forwards clicks on non-labelable descendants to the
            label's first labelable element — the listbox trigger —
            which re-toggles the dropdown on every option click. Blink
            only forwards when propagation is intact, WebKit always;
            a div sidesteps the quirk in every engine. */}
        {asSession && (
          <Field label="model" as="div">
            <ModelPicker
              agentId={catalogAgentId}
              value={modelSelection}
              onChange={(v) => setModelByType((prev) => ({ ...prev, [type]: v }))}
            />
          </Field>
        )}

        <Field label={asSession ? 'session name' : 'name'}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={asSession ? 'refactor checkout flow, …' : 'api-bot, frontend, …'}
            autoFocus
            className="w-full rounded-md bg-surface-2/40 px-3 py-2 text-sm text-fg-primary outline-none transition-colors placeholder:text-fg-muted focus:bg-surface-2"
          />
        </Field>

        {!asSession && (
          <>
            <Field label="working dir (optional)">
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
          </>
        )}

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

function Field({
  label,
  children,
  as: Tag = 'label',
}: {
  label: string;
  children: React.ReactNode;
  /** Use 'div' when the children embed interactive controls of their
   *  own (e.g. the model picker's listbox) — see the call site note on
   *  WebKit's label click-forwarding. */
  as?: 'label' | 'div';
}) {
  return (
    <Tag className="block">
      <span className="mb-1 block text-caps">{label}</span>
      {children}
    </Tag>
  );
}
