import { useLayoutEffect, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, RotateCcw } from 'lucide-react';
import type { AgentDTO } from '@argus/shared-types';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { cn } from '../lib/utils';

/**
 * Per-project icon. Default is `Folder` (or `FolderOpen` when the
 * project row is expanded — see `open` prop on the picker variant).
 * The user can override that default via the picker, choosing a single
 * A-Z letter that then renders in place of the folder. Stored on the
 * `LocalProject.iconKey` field; persisted to localStorage with the
 * rest of the placeholder.
 *
 * Why letters: a project with no icon defaults to the same Folder
 * glyph as every other project, which makes them visually identical
 * in the collapsed rail (and in the main sidebar when the project
 * row is closed). A user-picked letter is a deliberate memory aid —
 * once you've picked "A" for Argus and "B" for blog, the rail reads
 * at a glance. No auto-default from the project name; the act of
 * picking is what binds the letter to the project for the user.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Read-only glyph — used wherever we just need to *show* the project's
 * current icon (e.g. the collapsed rail tile). No picker, no
 * placeholder-creation side effects.
 */
export function ProjectIconGlyph({
  iconKey,
  open,
  className,
}: {
  iconKey: string | undefined;
  /** When true, the default Folder glyph uses the open variant. Has
   *  no effect when a letter is picked — letters don't have an
   *  open/closed state. */
  open?: boolean;
  /** Sizing + color are caller-controlled. Pass both a dimension
   *  (h-X w-X) AND a font-size (text-X) so the letter case lines up
   *  with the SVG case at the requested footprint. `leading-none`
   *  is applied internally so callers don't have to remember it. */
  className?: string;
}) {
  if (iconKey) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold leading-none',
          className,
        )}
      >
        {iconKey}
      </span>
    );
  }
  return open ? <FolderOpen className={className} /> : <Folder className={className} />;
}

type ProjectIconProps = {
  projectKey: string;
  machineId: string;
  workingDir: string | null;
  /** Falls back to the placeholder name first, then this label. */
  label: string;
  /** Agent ids in this project — used to derive a `supportsTerminal`
   *  fallback when no placeholder exists yet (so the picker can
   *  create a placeholder without losing terminal info). */
  agentIds: string[];
  /** Controls the default Folder open/closed variant. */
  open?: boolean;
  className?: string;
};

/**
 * Clickable icon — opens the letter picker. Use in the main sidebar's
 * project row where the user has the room to interact. The picker is
 * portaled out of the row so the sidebar's overflow doesn't clip it.
 *
 * Picking a letter calls `useProjectStore.add()` which merges by
 * `(machineId, workingDir)` — so this works on both placeholder-
 * backed and purely agent-derived rows. For the latter, the merge
 * auto-creates a placeholder using `supportsTerminal` derived from
 * the first agent's value. Only the iconKey is overwritten; other
 * placeholder fields stay intact.
 */
export function ProjectIcon({
  projectKey,
  machineId,
  workingDir,
  label,
  agentIds,
  open,
  className,
}: ProjectIconProps) {
  const project = useProjectStore((s) => s.projects[projectKey]);
  const iconKey = project?.iconKey;
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  // The picker writes through useProjectStore.add(). It needs
  // machineId/workingDir/name/supportsTerminal to be safe across the
  // create-or-merge cases — we resolve those here so the picker
  // component can be a thin UI shell.
  const canPick = !!workingDir;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (canPick) setPickerOpen((v) => !v);
        }}
        title={canPick ? 'change icon' : undefined}
        disabled={!canPick}
        className={cn(
          // `flex items-center justify-center` forces flex layout
          // inside the button so the inline-level letter span can't
          // inflate the button via inherited line-height. Without
          // this, a letter glyph at 11px sits in a 24px line box
          // (= 1.5 × inherited 16px) and the row grows ~8px taller
          // than it does with the SVG folder, which sidesteps the
          // line-box because it's replaced content.
          'flex shrink-0 items-center justify-center rounded-sm p-0.5 transition-colors',
          canPick && 'hover:bg-surface-2/60 hover:text-fg-primary',
          'disabled:cursor-default',
          className,
        )}
      >
        <ProjectIconGlyph
          iconKey={iconKey}
          open={open}
          className="h-3.5 w-3.5 text-[11px]"
        />
      </button>
      {pickerOpen && canPick && workingDir && (
        <ProjectIconPicker
          projectKey={projectKey}
          machineId={machineId}
          workingDir={workingDir}
          label={label}
          agentIds={agentIds}
          selected={iconKey}
          anchor={anchorRef}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

const POPOVER_WIDTH = 200;
const VIEWPORT_MARGIN = 8;

function ProjectIconPicker({
  projectKey,
  machineId,
  workingDir,
  label,
  agentIds,
  selected,
  anchor,
  onClose,
}: {
  projectKey: string;
  machineId: string;
  workingDir: string;
  label: string;
  agentIds: string[];
  selected: string | undefined;
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const addProject = useProjectStore((s) => s.add);
  const project = useProjectStore((s) => s.projects[projectKey]);
  const agents = useAgentStore((s) => s.agents);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function applyIcon(next: string | null) {
    // `null` from the reset button means "clear back to default
    // (Folder)"; a letter string means "set to this glyph". Same
    // (machineId, workingDir) key as everywhere else, so this
    // merges into the existing placeholder or creates one for a
    // purely agent-derived row. supportsTerminal is preserved from
    // the placeholder, with the first agent's value as a fallback —
    // same chain the rename and archive flows use.
    const firstAgent: AgentDTO | undefined = agents[agentIds[0]];
    addProject({
      machineId,
      name: project?.name || label,
      workingDir,
      supportsTerminal: project?.supportsTerminal ?? firstAgent?.supportsTerminal ?? false,
      iconKey: next,
    });
    onClose();
  }

  useLayoutEffect(() => {
    function place() {
      const a = anchor.current;
      const pop = popRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const popH = pop?.offsetHeight ?? 0;
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
      <div className="grid grid-cols-6 gap-1">
        {LETTERS.map((letter) => {
          const active = letter === selected;
          return (
            <button
              key={letter}
              type="button"
              onClick={(e) => {
                // React portals bubble events through the component
                // tree, so without stopPropagation this click reaches
                // ProjectRow's toggle button and flips expand state.
                e.stopPropagation();
                applyIcon(letter);
              }}
              title={letter}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-sm text-xs font-semibold transition-colors',
                active
                  ? 'bg-surface-2 text-fg-primary'
                  : 'text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary',
              )}
            >
              {letter}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 border-t border-default pt-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            applyIcon(null);
          }}
          disabled={!selected}
          title="reset to default folder"
          className={cn(
            'flex w-full items-center justify-center gap-1.5 rounded-sm py-1 text-xs transition-colors',
            !selected
              ? 'cursor-default text-fg-muted opacity-40'
              : 'text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary',
          )}
        >
          <RotateCcw className="h-3 w-3" />
          reset to folder
        </button>
      </div>
    </div>,
    document.body,
  );
}
