import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams } from 'react-router-dom';
import { LogOut, PanelLeftOpen } from 'lucide-react';
import type { MachineDTO, SessionDTO } from '@argus/shared-types';
import { MachineIconGlyph } from './MachineIcon';
import { ProjectIconGlyph } from './ProjectIcon';
import { useMachineStore } from '../stores/machineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { useProjectStore, useProjectIconKey } from '../stores/projectStore';
import { groupProjects, resolveProjectRef, type ProjectGroup } from '../lib/projects';
import { cn, relativeTime } from '../lib/utils';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon } from './ui/AgentTypeIcon';

/** Hover dwell before a tile's session flyout opens. Long enough that
 *  mouse travel across the rail doesn't flash panels, short enough to
 *  beat the ~1s native-title tooltip it replaces. */
const FLYOUT_OPEN_DELAY_MS = 500;
/** Grace period for crossing the gap between tile and flyout — the
 *  panel survives the pointer briefly leaving both. */
const FLYOUT_CLOSE_DELAY_MS = 200;
const VIEWPORT_MARGIN = 8;

/**
 * Thin (48px) rail shown in place of the full sidebar when the user
 * collapses it. Mirrors the main sidebar's project-first model: one
 * tile per project (folder or user-picked letter glyph), click jumps
 * to the project's most-recent non-archived session across any of
 * its agents. Hovering a tile for a beat opens a session flyout so a
 * specific session is reachable without re-expanding the sidebar.
 * The machine strip below remains the canonical surface for
 * navigating directly to a host.
 *
 * Always hides archived projects + archived agents — the rail is for
 * "what am I working on now," not for unearthing history. The
 * synthetic "no project" bucket is also hidden: it has no path
 * identity, so a rail tile would be ambiguous and the user can't
 * make agents-without-workingDir anyway from the main sidebar.
 */
export function SidebarRail() {
  const { sessionId, machineId } = useParams();
  const sessions = useSessionStore((s) => s.sessions);
  const machines = useMachineStore((s) => s.machines);
  const machineOrder = useMachineStore((s) => s.order);
  const localProjects = useProjectStore((s) => s.projects);
  const localProjectOrder = useProjectStore((s) => s.order);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  // Rail is "active state" only — no archive visibility toggle.
  const visibleLocalOrder = localProjectOrder.filter(
    (k) => !localProjects[k]?.archivedAt,
  );
  const projects = groupProjects(localProjects, visibleLocalOrder).filter(
    (p) => !!p.fullPath,
  );

  // Non-archived sessions per project, most-recent first. [0] is the
  // tile's click target ("land where they'd expect"); the full list
  // feeds the hover flyout. Walking all sessions is O(n) and N is
  // small in practice; not worth memoizing.
  const sessionsByProject = new Map<string, SessionDTO[]>();
  for (const s of Object.values(sessions)) {
    if (s.archivedAt) continue;
    // Group by the session's pinned project (machineId, workingDir) —
    // the tile keys groupProjects emits use the same shape.
    const ref = resolveProjectRef(s, localProjects);
    if (!ref) continue;
    const key = `${ref.machineId}::${ref.workingDir}`;
    const list = sessionsByProject.get(key);
    if (list) list.push(s);
    else sessionsByProject.set(key, [s]);
  }
  for (const list of sessionsByProject.values()) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // Highlight the project containing the currently-viewed session
  // (if any), keyed the same way as the tiles above.
  let activeProjectKey: string | undefined;
  if (sessionId) {
    const ref = resolveProjectRef(sessions[sessionId], localProjects);
    if (ref) activeProjectKey = `${ref.machineId}::${ref.workingDir}`;
  }

  return (
    <aside className="flex h-full w-full flex-col items-stretch border-r border-default bg-surface-0">
      <div className="flex h-12 shrink-0 items-center justify-center border-b border-default">
        <button
          onClick={toggleSidebar}
          title="show sidebar"
          className="rounded-md p-1.5 text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary transition-colors"
        >
          <PanelLeftOpen className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
        {projects.map((p) => (
          <RailProjectTile
            key={p.key}
            project={p}
            sessions={sessionsByProject.get(p.key) ?? []}
            active={p.key === activeProjectKey}
            activeSessionId={sessionId}
            machine={machines[p.machineId]}
          />
        ))}
      </div>

      {machineOrder.length > 0 && (
        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-default py-2 max-h-[40%] overflow-y-auto">
          {machineOrder.map((id) => {
            const m = machines[id];
            if (!m) return null;
            const active = m.id === machineId;
            const offline = m.status === 'offline';
            return (
              <Link
                key={id}
                to={`/machines/${m.id}`}
                title={`${m.name} · ${m.hostname}`}
                className={cn(
                  'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                  active ? 'bg-surface-2' : 'hover:bg-surface-1',
                  offline && 'opacity-60',
                )}
              >
                <MachineIconGlyph machineId={m.id} className="h-4 w-4 text-fg-tertiary" />
                <span className="absolute -bottom-0.5 -right-0.5">
                  <StatusDot status={m.status === 'online' ? 'online' : 'offline'} />
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <div className="flex h-11 shrink-0 items-center justify-center border-t border-default">
        <button
          onClick={logout}
          title={user?.email ?? 'sign out'}
          className="rounded-md p-1.5 text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>
    </aside>
  );
}

/**
 * One project tile + its hover-dwell session flyout. Click keeps the
 * rail's original contract (jump to most-recent session); hovering
 * for FLYOUT_OPEN_DELAY_MS floats the project's session list beside
 * the rail so any session is one click away while collapsed.
 *
 * The tile's old native `title` tooltip is gone — the flyout header
 * carries the same label/path/machine info, and the two would race
 * each other on hover otherwise.
 */
function RailProjectTile({
  project,
  sessions,
  active,
  activeSessionId,
  machine,
}: {
  project: ProjectGroup;
  /** Non-archived sessions, most-recent first. */
  sessions: SessionDTO[];
  active: boolean;
  activeSessionId: string | undefined;
  machine: MachineDTO | undefined;
}) {
  const tileRef = useRef<HTMLDivElement>(null);
  const iconKey = useProjectIconKey(project.key);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );

  // Shared by tile and flyout: entering either cancels a pending
  // close, leaving either schedules one. The close grace exceeds the
  // pointer's travel time across the tile→panel gap, so the flyout
  // doesn't blink while crossing.
  function pointerEnter() {
    window.clearTimeout(closeTimer.current);
    if (flyoutOpen) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(
      () => setFlyoutOpen(true),
      FLYOUT_OPEN_DELAY_MS,
    );
  }
  function pointerLeave() {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(
      () => setFlyoutOpen(false),
      FLYOUT_CLOSE_DELAY_MS,
    );
  }
  function close() {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setFlyoutOpen(false);
  }

  const recentId = sessions[0]?.id;
  const content = (
    <div
      className={cn(
        'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
        active ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary hover:bg-surface-1',
        !recentId && 'opacity-50 cursor-not-allowed',
      )}
    >
      <ProjectIconGlyph
        iconKey={iconKey}
        className="h-5 w-5 text-sm"
      />
    </div>
  );

  return (
    <div ref={tileRef} onMouseEnter={pointerEnter} onMouseLeave={pointerLeave}>
      {recentId ? (
        <Link to={`/sessions/${recentId}`} onClick={close}>
          {content}
        </Link>
      ) : (
        <div role="button" aria-disabled>
          {content}
        </div>
      )}
      {flyoutOpen && (
        <RailSessionFlyout
          project={project}
          sessions={sessions}
          machine={machine}
          activeSessionId={activeSessionId}
          anchor={tileRef}
          onPointerEnter={pointerEnter}
          onPointerLeave={pointerLeave}
          onClose={close}
        />
      )}
    </div>
  );
}

/**
 * The floating session list itself. Portaled to <body> so it escapes
 * the rail's `overflow-y-auto` project strip (same trick as
 * CreateAgentPopover): floats to the right of the anchor tile, top-
 * aligned, with the bottom edge clamped to the viewport. The rail is
 * pinned to the left edge so there's no "flip to the other side"
 * fallback to worry about.
 */
function RailSessionFlyout({
  project,
  sessions,
  machine,
  activeSessionId,
  anchor,
  onPointerEnter,
  onPointerLeave,
  onClose,
}: {
  project: ProjectGroup;
  sessions: SessionDTO[];
  machine: MachineDTO | undefined;
  activeSessionId: string | undefined;
  anchor: React.RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Mirror CreateAgentPopover's placement loop: position before first
  // paint, then follow resizes/scrolls (the project strip scrolls
  // independently) and the panel's own size changes.
  useLayoutEffect(() => {
    function place() {
      const a = anchor.current;
      const pop = popRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const popH = pop?.offsetHeight ?? 0;
      const left = rect.right + 8;
      let top = rect.top;
      if (popH && top + popH + VIEWPORT_MARGIN > window.innerHeight) {
        top = Math.max(VIEWPORT_MARGIN, window.innerHeight - popH - VIEWPORT_MARGIN);
      }
      setPos({ top, left });
    }
    place();
    const pop = popRef.current;
    const observer = pop ? new ResizeObserver(() => place()) : null;
    if (observer && pop) observer.observe(pop);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={popRef}
      style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0 }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className="z-40 w-64 overflow-hidden rounded-md border border-default bg-surface-0 shadow-lg"
    >
      <div className="border-b border-default px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-fg-primary">
            {project.label}
          </span>
          <MachineIconGlyph
            machineId={project.machineId}
            className="h-3 w-3 shrink-0 text-fg-muted"
          />
        </div>
        <div className="truncate text-meta text-fg-muted">
          {[project.fullPath, machine?.name].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto p-1">
        {sessions.map((s) => {
          const agentType = s.cliType ?? undefined;
          // Same status-dot language as the full sidebar's SessionRow:
          // amber running, red failed, emerald done-but-unseen.
          return (
            <Link
              key={s.id}
              to={`/sessions/${s.id}`}
              onClick={onClose}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm leading-5 transition-colors hover:bg-surface-1',
                activeSessionId === s.id && 'bg-surface-1 text-fg-primary',
              )}
            >
              {agentType && <AgentTypeIcon type={agentType} />}
              {s.status === 'active' && (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
              )}
              {s.unread && s.status === 'failed' && (
                <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
              )}
              {s.unread && s.status === 'idle' && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
              )}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  s.unread ? 'font-semibold text-fg-primary' : 'text-fg-secondary',
                )}
              >
                {s.title}
              </span>
              <span className="shrink-0 text-meta text-fg-muted">
                {relativeTime(s.updatedAt)}
              </span>
            </Link>
          );
        })}
        {sessions.length === 0 && (
          <div className="px-2 py-1.5 text-meta italic text-fg-muted">
            no sessions
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
