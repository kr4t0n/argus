import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowUpCircle,
  ChevronRight,
  Eye,
  EyeOff,
  MoreVertical,
  PanelLeftClose,
  Pencil,
  Plus,
} from 'lucide-react';
import type { AgentType, MachineDTO, SessionDTO } from '@argus/shared-types';
import { useMachineStore } from '../stores/machineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useSidecarUpdateStore } from '../stores/sidecarUpdateStore';
import { useProjectStore } from '../stores/projectStore';
import { groupProjects, type ProjectGroup } from '../lib/projects';
import { cn, relativeTime } from '../lib/utils';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon } from './ui/AgentTypeIcon';
import { CreateAgentPopover } from './CreateAgentPopover';
import { CreateProjectPopover } from './CreateProjectPopover';
import { ProjectIcon } from './ProjectIcon';
import { BulkUpdateModal } from './BulkUpdateModal';
import { MachineIcon, MachineIconGlyph } from './MachineIcon';
import { ThemeToggle } from './ThemeToggle';
import { UserRow } from './UserRow';
import { api } from '../lib/api';


export function Sidebar() {
  const { sessionId } = useParams();
  const machines = useMachineStore((s) => s.machines);
  const sessions = useSessionStore((s) => s.sessions);
  const expanded = useUIStore((s) => s.expanded);
  const toggle = useUIStore((s) => s.toggleExpanded);
  const showArchived = useUIStore((s) => s.showArchived);
  const toggleShowArchived = useUIStore((s) => s.toggleShowArchived);
  const showArchivedProjects = useUIStore((s) => s.showArchivedProjects);
  const toggleShowArchivedProjects = useUIStore((s) => s.toggleShowArchivedProjects);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const localProjects = useProjectStore((s) => s.projects);
  const localProjectOrder = useProjectStore((s) => s.order);

  // Sessions group under their pinned project (Phase 2+); with agents
  // retired this is the only grouping key.
  const sessionsByProject: Record<string, SessionDTO[]> = {};
  for (const s of Object.values(sessions)) {
    if (s.projectId) (sessionsByProject[s.projectId] ||= []).push(s);
  }
  for (const list of Object.values(sessionsByProject)) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const visibleLocalOrder = showArchivedProjects
    ? localProjectOrder
    : localProjectOrder.filter((k) => !localProjects[k]?.archivedAt);
  const projects = groupProjects(localProjects, visibleLocalOrder);
  // Projects (placeholders) are the unit of navigation in the flat tree,
  // so the toggle counts archived placeholders.
  const archivedProjectCount = Object.values(localProjects).filter(
    (p) => !!p.archivedAt,
  ).length;
  const hiddenArchivedProjectCount = showArchivedProjects ? 0 : archivedProjectCount;

  return (
    <aside className="h-full w-full flex flex-col border-r border-default bg-surface-0">
      <div className="shrink-0 pl-6 pr-4 pt-4 pb-3 flex items-center justify-between min-h-[52px]">
        <span className="text-display font-display">Argus</span>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <button
            onClick={toggleSidebar}
            className="text-fg-tertiary hover:text-fg-primary transition-colors"
            title="hide sidebar"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1 px-2">
        {projects.length === 0 && (
          <div className="px-4 py-6 text-xs text-fg-tertiary">
            No projects yet — hover a machine below and click{' '}
            <Plus className="inline h-3 w-3 -mt-0.5" /> to create one.
          </div>
        )}
        {projects.map((p) => {
          const projOpen = expanded[`proj:${p.key}`] !== false;
          return (
            <ProjectRow
              key={p.key}
              project={p}
              open={projOpen}
              onToggle={() => toggle(`proj:${p.key}`)}
              machine={machines[p.machineId]}
              sessionsByProject={sessionsByProject}
              activeSessionId={sessionId}
              showArchivedMap={showArchived}
              onToggleShowArchived={toggleShowArchived}
            />
          );
        })}
        {!showArchivedProjects && hiddenArchivedProjectCount > 0 && (
          <button
            onClick={toggleShowArchivedProjects}
            className="mt-1 flex items-center gap-1.5 px-3 py-1.5 w-full text-left text-xs rounded-md text-fg-muted hover:text-fg-secondary hover:bg-surface-1 transition-colors"
          >
            <Archive className="h-3 w-3" />
            {hiddenArchivedProjectCount} archived project
            {hiddenArchivedProjectCount === 1 ? '' : 's'}
          </button>
        )}
        {showArchivedProjects && archivedProjectCount > 0 && (
          <button
            onClick={toggleShowArchivedProjects}
            className="mt-1 flex items-center gap-1.5 px-3 py-1.5 w-full text-left text-xs rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-surface-1 transition-colors"
          >
            <Archive className="h-3 w-3" />
            hide archived projects
          </button>
        )}
      </div>

      <MachineList />
      <UserRow />
    </aside>
  );
}

function ProjectRow({
  project,
  open,
  onToggle,
  machine,
  sessionsByProject,
  activeSessionId,
  showArchivedMap,
  onToggleShowArchived,
}: {
  project: ProjectGroup;
  open: boolean;
  onToggle: () => void;
  machine: MachineDTO | undefined;
  sessionsByProject: Record<string, SessionDTO[]>;
  activeSessionId: string | undefined;
  /**
   * Per-project show-archived state, keyed by `project.key` (was
   * per-agent before the flatten). Old agent-id-keyed entries in
   * `uiStore.showArchived` survive as harmless orphans.
   */
  showArchivedMap: Record<string, boolean>;
  onToggleShowArchived: (projectKey: string) => void;
}) {
  // Machine name falls back to the machineId until the Machine row loads.
  const machineName = machine?.name ?? project.machineId;
  const machineMeta = machine
    ? `${machine.hostname} · ${machine.os}/${machine.arch} · sidecar ${machine.sidecarVersion}`
    : machineName;
  const titleParts = [project.fullPath ?? 'sessions without a workingDir', machineMeta];

  const rowRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.label);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const setProjectArchived = useProjectStore((s) => s.setArchived);
  const addProject = useProjectStore((s) => s.add);

  // Mirror SessionRow's inline-edit pattern: focus + select on enter,
  // sync draft to source of truth when not editing so external label
  // updates (e.g. cascade restore) don't get stranded in the input.
  useEffect(() => {
    if (editing) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (!editing) setDraft(project.label);
  }, [project.label, editing]);

  // The "no project" bucket has no path → no project identity to rename.
  // Synthetic group, not a placeholder candidate.
  const canRename = !!project.fullPath;

  function startEdit(e: React.MouseEvent | React.SyntheticEvent) {
    if (!canRename) return;
    e.preventDefault();
    e.stopPropagation();
    setDraft(project.label);
    setEditing(true);
  }
  function commitRename() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === project.label || !project.fullPath) {
      setDraft(project.label);
      return;
    }
    // Re-add with the new name — `add()` merges on (machineId,
    // workingDir) so this updates an existing placeholder or
    // creates one for a purely agent-derived row. supportsTerminal
    // is preserved from the placeholder (or falls back to the first
    // agent's value to match the rest of the file's convention).
    addProject({
      machineId: project.machineId,
      name: next,
      workingDir: project.fullPath,
      supportsTerminal: project.local?.supportsTerminal ?? false,
    });
  }
  function cancelRename() {
    setDraft(project.label);
    setEditing(false);
  }

  // Every session in the project, most-recent first. Sessions are keyed
  // by `session.projectId` (agents are retired, so there's no agent join
  // anymore). The AgentTypeIcon prefix on each SessionRow still carries
  // the CLI identity via `session.cliType`.
  const serverProjectId = project.local?.serverId;
  const allSessions = serverProjectId ? (sessionsByProject[serverProjectId] ?? []) : [];
  const archivedVisible = showArchivedMap[project.key] ?? false;
  const visibleSessions = archivedVisible
    ? allSessions
    : allSessions.filter((s) => !s.archivedAt);
  const hiddenArchivedCount = allSessions.length - visibleSessions.length;
  const hasArchivedSessions = allSessions.some((s) => !!s.archivedAt);

  // The `+` opens the session popover. Only meaningful when we have a
  // real workingDir to anchor the project against and the machine is
  // online. The synthetic "no project" bucket has no path, so we hide it.
  const canCreateSession =
    !!project.fullPath &&
    !!machine &&
    machine.status !== 'offline' &&
    !project.archived;
  // Archive cascades to the project's sessions. Hidden on the "no
  // project" bucket — there's no path to anchor a placeholder against.
  const canArchive = !!project.fullPath;

  async function toggleProjectArchive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (archiveBusy || !project.fullPath) return;
    setArchiveBusy(true);
    try {
      if (project.archived) {
        // Restore. Prefer the snapshot — un-archive only the sessions
        // this cascade originally archived, so any individual archives
        // the user made BEFORE the cascade stay archived. Fall through
        // to a broad restore (un-archive every currently-archived
        // session in the project) only for legacy placeholders that
        // pre-date the snapshot.
        const snapSessions = project.local?.archivedSessionIds;
        const toRestore =
          snapSessions !== undefined
            ? snapSessions
            : allSessions.filter((s) => s.archivedAt).map((s) => s.id);
        const sessionResults = await Promise.all(
          toRestore.map((id) => api.unarchiveSession(id).catch(() => null)),
        );
        sessionResults.forEach((s) => s && upsertSession(s));

        await setProjectArchived(project.key, false);
      } else {
        // Archive: snapshot the sessions we actually flip (skipping ones
        // already archived) so restore can be surgical, then persist the
        // placeholder + snapshot. Auto-create the placeholder for a
        // server-derived row so the project keeps a stable restore id.
        const sessionIdsToArchive = allSessions
          .filter((s) => !s.archivedAt)
          .map((s) => s.id);

        const sessionResults = await Promise.allSettled(
          sessionIdsToArchive.map((id) => api.archiveSession(id)),
        );
        const archivedSessionIds: string[] = [];
        sessionResults.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            upsertSession(r.value);
            archivedSessionIds.push(sessionIdsToArchive[i]);
          }
        });

        if (!project.local) {
          await addProject({
            machineId: project.machineId,
            name: project.label,
            workingDir: project.fullPath,
            supportsTerminal: false,
            archivedAt: new Date().toISOString(),
            archivedAgentIds: [],
            archivedSessionIds,
          });
        } else {
          await setProjectArchived(project.key, true, {
            archivedAgentIds: [],
            archivedSessionIds,
          });
        }
      }
    } catch {
      /* swallow — toast surface not wired yet */
    } finally {
      setArchiveBusy(false);
    }
  }

  return (
    <div className="mb-0.5">
      <div
        ref={rowRef}
        className={cn(
          'group relative flex items-center rounded-md transition-colors hover:bg-surface-1',
          project.archived && 'opacity-70',
        )}
      >
        {editing ? (
          // Edit mode: no `title` on the wrapper — a native tooltip
          // would otherwise hover over the input itself. Chevron stays
          // visible (and decorative) so the row shape doesn't shift.
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left">
            <ChevronRight
              className={cn(
                'h-3 w-3 text-fg-tertiary transition-transform',
                open && 'rotate-90',
              )}
            />
            <ProjectIcon
              projectKey={project.key}
              machineId={project.machineId}
              workingDir={project.fullPath}
              open={open}
              className="text-fg-tertiary"
            />
            <input
              ref={renameInputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onClick={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              className="min-w-0 flex-1 rounded bg-surface-2 px-1 py-0.5 text-sm font-medium text-fg-primary outline-none ring-1 ring-default-strong focus:ring-fg-tertiary"
            />
            <MachineIconGlyph
              machineId={project.machineId}
              className="h-3 w-3 shrink-0 text-fg-muted"
            />
            <span className="ml-auto pl-1 text-meta text-fg-muted">{visibleSessions.length}</span>
          </div>
        ) : (
          <button
            onClick={onToggle}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left"
            title={titleParts.join(' · ')}
          >
            <ChevronRight
              className={cn(
                'h-3 w-3 text-fg-tertiary transition-transform',
                open && 'rotate-90',
              )}
            />
            <ProjectIcon
              projectKey={project.key}
              machineId={project.machineId}
              workingDir={project.fullPath}
              open={open}
              className="text-fg-tertiary"
            />
            <span
              className={cn(
                'min-w-0 truncate text-sm font-medium',
                project.archived ? 'italic text-fg-tertiary' : 'text-fg-primary',
              )}
            >
              {project.label}
            </span>
            <MachineIconGlyph
              machineId={project.machineId}
              className="h-3 w-3 shrink-0 text-fg-muted"
            />
            <span className="ml-auto pl-1 text-meta text-fg-muted">{visibleSessions.length}</span>
          </button>
        )}

        {!editing && (canCreateSession || canArchive || canRename) && (
          <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            <span
              aria-hidden
              className="absolute inset-y-0 right-full w-8 bg-gradient-to-r from-transparent to-surface-1"
            />
            <div className="flex items-center bg-surface-1">
              {canRename && (
                <button
                  onClick={startEdit}
                  className="flex items-center px-1.5 text-fg-muted transition-colors hover:text-fg-primary"
                  title="rename project"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              {canCreateSession && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setCreateSessionOpen(true);
                  }}
                  className="flex items-center px-1.5 text-fg-muted transition-colors hover:text-fg-primary"
                  title="create session in this project"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
              {canArchive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleShowArchived(project.key);
                  }}
                  className={cn(
                    'flex items-center px-1.5 transition-colors',
                    archivedVisible
                      ? 'text-emerald-400 hover:text-emerald-300'
                      : 'text-fg-muted hover:text-fg-secondary',
                  )}
                  title={
                    archivedVisible
                      ? 'hide archived sessions'
                      : hasArchivedSessions
                        ? `show ${hiddenArchivedCount} archived session${hiddenArchivedCount === 1 ? '' : 's'}`
                        : 'show archived sessions'
                  }
                >
                  {archivedVisible ? (
                    <Eye className="h-3.5 w-3.5" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              {canArchive && (
                <button
                  onClick={toggleProjectArchive}
                  disabled={archiveBusy}
                  className={cn(
                    'flex items-center px-1.5 text-fg-muted transition-colors disabled:opacity-40 hover:text-fg-primary',
                    project.archived && 'text-fg-tertiary',
                  )}
                  title={
                    project.archived
                      ? 'restore project (sessions inside)'
                      : 'archive project (cascades to sessions inside)'
                  }
                >
                  {project.archived ? (
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  ) : (
                    <Archive className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {createSessionOpen && machine && (
          <CreateAgentPopover
            machine={machine}
            anchor={rowRef}
            onClose={() => setCreateSessionOpen(false)}
            defaults={{
              workingDir: project.fullPath ?? undefined,
              supportsTerminal: project.local?.supportsTerminal ?? false,
            }}
          />
        )}
      </div>

      {open && (
        <div className="ml-4 mt-0.5 space-y-0.5 border-l border-default pl-1">
          {visibleSessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={activeSessionId === s.id}
              agentType={s.cliType ?? undefined}
            />
          ))}
          {visibleSessions.length === 0 && (
            <div className="px-2 py-1 text-meta text-fg-muted italic">
              {hasArchivedSessions && !archivedVisible
                ? 'all sessions archived — click the eye to reveal'
                : canCreateSession
                  ? 'no sessions yet — hover the row and click + to create one'
                  : 'no sessions'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Bottom-of-sidebar machine roster. Shows every host that has run
 * `argus-sidecar init` against this server, even ones currently
 * offline.
 *
 * Hover a machine to reveal a `+` that opens CreateProjectPopover —
 * the entry point for creating a *project* on this machine. Projects
 * are client-only placeholders (see `useProjectStore`); they appear
 * in the upper tree as empty rows until an agent is created inside
 * them via the project row's own hover `+`. Agents on this machine
 * also keep flowing through MachinePanel's free-form popover for
 * cases where you don't want a project anchor.
 */
function MachineList() {
  const order = useMachineStore((s) => s.order);
  const machines = useMachineStore((s) => s.machines);
  const [openFor, setOpenFor] = useState<string | null>(null);

  if (order.length === 0) {
    return (
      <div className="shrink-0 px-4 py-3 text-meta text-fg-muted">
        no machines connected. Run{' '}
        <code className="rounded bg-surface-1 px-1 py-0.5 font-mono text-fg-tertiary">
          argus-sidecar init
        </code>{' '}
        on a host.
      </div>
    );
  }

  return (
    <div className="shrink-0 py-1.5 px-1 max-h-[40%] overflow-y-auto">
      <div className="group flex items-center px-3 py-1">
        <span className="text-caps">machines</span>
        <span className="ml-1.5 text-meta text-fg-muted">({order.length})</span>
        <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
          <MachinesHeaderMenu />
        </span>
      </div>
      {order.map((id) => {
        const m = machines[id];
        if (!m) return null;
        return (
          <MachineRow
            key={id}
            machine={m}
            popoverOpen={openFor === id}
            onOpenPopover={() => setOpenFor(id)}
            onClosePopover={() => setOpenFor(null)}
          />
        );
      })}
    </div>
  );
}

/**
 * Top-of-machines kebab. Currently exposes "Update all sidecars …" only;
 * we keep it as a menu so future fleet-wide actions (collect logs,
 * health check, …) have an obvious home.
 *
 * Clicking the action opens BulkUpdateModal, which fetches the current
 * plan from POST /machines/sidecar/update-all (the server returns the
 * full plan with each row's pre-flight `status` set), lets the user
 * confirm, and then either confirms execution or cancels the batch.
 */
function MachinesHeaderMenu() {
  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const batch = useSidecarUpdateStore((s) => s.batch);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  // While a bulk update is in flight (we have a non-dismissed batch),
  // we disable the entry to discourage starting a parallel run; the
  // server's single-flight per machine would catch overlap anyway.
  const batchInFlight =
    !!batch &&
    !batch.dismissed &&
    batch.plan.some((p) => p.status === 'queued' || p.status === 'in-progress');

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded p-0.5 text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary"
        title="machine actions"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-default bg-surface-0 shadow-lg">
          <button
            onClick={() => {
              setOpen(false);
              setShowModal(true);
            }}
            disabled={batchInFlight}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-xs',
              'text-fg-primary hover:bg-surface-1',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
            title={batchInFlight ? 'a bulk update is already in progress' : undefined}
          >
            <ArrowUpCircle className="h-3.5 w-3.5" />
            Update all sidecars…
          </button>
        </div>
      )}
      {showModal && <BulkUpdateModal onClose={() => setShowModal(false)} />}
    </div>
  );
}

function MachineRow({
  machine,
  popoverOpen,
  onOpenPopover,
  onClosePopover,
}: {
  machine: MachineDTO;
  popoverOpen: boolean;
  onOpenPopover: () => void;
  onClosePopover: () => void;
}) {
  const { machineId: activeMachineId } = useParams();
  const active = activeMachineId === machine.id;
  const adapters = machine.availableAdapters ?? [];
  const offline = machine.status === 'offline';
  // Anchor the popover off the row's `+` button via a ref. We use a
  // portal (rendered inside CreateAgentPopover) so the popover escapes
  // the sidebar's `overflow-y-auto` machine-list container, which
  // otherwise clips it (the sidebar is short, the popover is taller
  // than the gap above the bottom-pinned machine list).
  const anchorRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={anchorRef}
      className={cn(
        'group flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors hover:bg-surface-1',
        active && 'bg-surface-1',
        offline && 'opacity-60',
      )}
    >
      <MachineIcon machineId={machine.id} className="text-fg-tertiary" />
      <Link to={`/machines/${machine.id}`} className="min-w-0 flex-1 outline-none">
        <div
          className="truncate text-xs text-fg-primary"
          title={`${machine.hostname} · ${machine.os}/${machine.arch} · sidecar ${machine.sidecarVersion}`}
        >
          {machine.name}
        </div>
        <div className="truncate text-meta text-fg-muted">
          {adapters.length} adapter{adapters.length === 1 ? '' : 's'}
        </div>
      </Link>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpenPopover();
        }}
        className={cn(
          'ml-0.5 flex items-center text-fg-tertiary transition-opacity hover:text-fg-primary',
          popoverOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        title="create project on this machine"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {/* Liveness dot — pinned to the rightmost slot so it reads as a
          persistent status indicator. Mirrors the AgentRow layout
          (hover actions sit to its left). */}
      <span className="flex items-center pr-2">
        <StatusDot status={machine.status === 'online' ? 'online' : 'offline'} />
      </span>

      {popoverOpen && (
        <CreateProjectPopover machine={machine} anchor={anchorRef} onClose={onClosePopover} />
      )}
    </div>
  );
}

function SessionRow({
  session,
  active,
  agentType,
}: {
  session: SessionDTO;
  active: boolean;
  /** The session's parent agent type — drives the leading icon so the
   *  user can tell a claude session from a codex one without an agent
   *  row to nest under. Undefined while the agent record is still
   *  loading; the icon component renders a generic glyph then. */
  agentType?: AgentType;
}) {
  const nav = useNavigate();
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const archived = !!session.archivedAt;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(session.title);
  }, [session.title, editing]);

  function startEdit(e: React.MouseEvent | React.SyntheticEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDraft(session.title);
    setEditing(true);
  }

  async function commit() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === session.title) {
      setDraft(session.title);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.renameSession(session.id, next);
      upsertSession(updated);
    } catch {
      setDraft(session.title);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setDraft(session.title);
    setEditing(false);
  }

  async function toggleArchive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const updated = archived
        ? await api.unarchiveSession(session.id)
        : await api.archiveSession(session.id);
      upsertSession(updated);
      // If we just archived the session we're viewing, back out to the home view.
      if (!archived && active) nav('/');
    } catch {
      /* swallow — toast surface not wired yet */
    } finally {
      setBusy(false);
    }
  }

  // Dot visibility comes from `unread`; its color comes from `status`.
  // While a turn runs (`active`) the amber dot always shows; once it
  // finishes, the dot persists only until the user opens the session.
  const unread = !archived && session.unread;
  const content = (
    <span className="flex items-center gap-1.5 min-w-0 flex-1">
      {agentType && <AgentTypeIcon type={agentType} />}
      {!archived && session.status === 'active' && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
      )}
      {unread && session.status === 'failed' && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0"
          title="task failed — open to mark seen"
        />
      )}
      {unread && session.status === 'idle' && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0"
          title="task complete — open to mark seen"
        />
      )}
      {archived && <Archive className="h-3 w-3 shrink-0 text-fg-muted" />}
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className="min-w-0 flex-1 rounded bg-surface-2 px-1 py-0.5 text-sm text-fg-primary outline-none ring-1 ring-default-strong focus:ring-fg-tertiary"
        />
      ) : (
        <span
          className={cn(
            'truncate',
            archived ? 'text-fg-tertiary italic' : 'text-fg-secondary',
            unread && 'font-semibold text-fg-primary',
            saving && 'opacity-60',
          )}
          onDoubleClick={startEdit}
          title={archived ? 'archived — double-click to rename' : 'double-click to rename'}
        >
          {session.title}
        </span>
      )}
    </span>
  );

  const meta = (
    <span className="ml-2 flex shrink-0 items-center gap-1.5">
      {!editing && (
        <>
          <button
            onClick={startEdit}
            className="text-fg-muted opacity-0 transition group-hover:opacity-100 hover:text-fg-primary"
            title="rename session"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={toggleArchive}
            disabled={busy}
            className={cn(
              'text-fg-muted opacity-0 transition group-hover:opacity-100 hover:text-fg-primary disabled:opacity-40',
              archived && 'opacity-100 text-fg-tertiary',
            )}
            title={archived ? 'restore from archive' : 'archive session'}
          >
            {archived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
          </button>
        </>
      )}
      <span className="text-meta text-fg-muted">{relativeTime(session.updatedAt)}</span>
    </span>
  );

  const rowClass = cn(
    'group flex items-center justify-between rounded-md px-2 py-1 text-sm leading-5 transition-colors hover:bg-surface-1',
    active && 'bg-surface-1 text-fg-primary',
    archived && 'opacity-70',
  );

  if (editing) {
    return (
      <div className={rowClass}>
        {content}
        {meta}
      </div>
    );
  }

  return (
    <Link to={`/sessions/${session.id}`} className={rowClass}>
      {content}
      {meta}
    </Link>
  );
}

