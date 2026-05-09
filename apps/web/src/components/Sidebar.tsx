import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowUpCircle,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  MoreVertical,
  PanelLeftClose,
  Pencil,
  Plus,
} from 'lucide-react';
import type { AgentDTO, MachineDTO, SessionDTO } from '@argus/shared-types';
import { useAgentStore } from '../stores/agentStore';
import { useMachineStore } from '../stores/machineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useSidecarUpdateStore } from '../stores/sidecarUpdateStore';
import { cn, relativeTime } from '../lib/utils';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon } from './ui/AgentTypeIcon';
import { CreateAgentPopover } from './CreateAgentPopover';
import { BulkUpdateModal } from './BulkUpdateModal';
import { MachineIcon, MachineIconGlyph } from './MachineIcon';
import { ThemeToggle } from './ThemeToggle';
import { UserRow } from './UserRow';
import { api } from '../lib/api';

const NO_PROJECT_KEY = '__none__';

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

interface ProjectGroup {
  key: string;
  label: string;
  fullPath: string | null;
  machineId: string;
  agentIds: string[];
}

/**
 * Bucket the global agent `order` into projects, where a project is a
 * unique `(workingDir, machineId)` pair — same path on different
 * machines lives on different physical filesystems, so they shouldn't
 * be merged. Agents with no `workingDir` fall into a synthetic
 * "no project" bucket per machine so they remain reachable.
 *
 * Input order is preserved so adding/removing an agent doesn't
 * reshuffle unrelated rows.
 */
function groupAgents(order: string[], agents: Record<string, AgentDTO>): ProjectGroup[] {
  const projects: ProjectGroup[] = [];
  const projectIndex = new Map<string, number>();

  for (const id of order) {
    const a = agents[id];
    if (!a) continue;
    const wd = (a.workingDir ?? '').trim();
    const wdKey = wd || NO_PROJECT_KEY;
    const key = `${a.machineId}::${wdKey}`;
    let pIdx = projectIndex.get(key);
    if (pIdx === undefined) {
      pIdx = projects.length;
      projectIndex.set(key, pIdx);
      projects.push({
        key,
        label: wd ? basename(wd) : 'no project',
        fullPath: wd || null,
        machineId: a.machineId,
        agentIds: [],
      });
    }
    projects[pIdx].agentIds.push(id);
  }
  return projects;
}

export function Sidebar() {
  const { sessionId } = useParams();
  const nav = useNavigate();
  const agents = useAgentStore((s) => s.agents);
  const order = useAgentStore((s) => s.order);
  const machines = useMachineStore((s) => s.machines);
  const sessions = useSessionStore((s) => s.sessions);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const expanded = useUIStore((s) => s.expanded);
  const toggle = useUIStore((s) => s.toggleAgentExpanded);
  const showArchived = useUIStore((s) => s.showArchived);
  const toggleShowArchived = useUIStore((s) => s.toggleShowArchived);
  const showArchivedAgents = useUIStore((s) => s.showArchivedAgents);
  const toggleShowArchivedAgents = useUIStore((s) => s.toggleShowArchivedAgents);
  const upsertAgent = useAgentStore((s) => s.upsert);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  async function startSession(agentId: string) {
    const { session } = await api.createSession({ agentId });
    upsertSession(session);
    nav(`/sessions/${session.id}`);
  }

  const sessionsByAgent: Record<string, SessionDTO[]> = {};
  for (const s of Object.values(sessions)) {
    (sessionsByAgent[s.agentId] ||= []).push(s);
  }
  for (const list of Object.values(sessionsByAgent)) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const visibleOrder = showArchivedAgents
    ? order
    : order.filter((id) => !agents[id]?.archivedAt);
  const projects = groupAgents(visibleOrder, agents);
  const hiddenArchivedAgentCount = order.length - visibleOrder.length;
  const hasArchivedAgents = order.some((id) => agents[id]?.archivedAt);

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
            No agents yet — hover a machine below and click{' '}
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
              expanded={expanded}
              onToggleAgent={toggle}
              machine={machines[p.machineId]}
              agents={agents}
              sessionsByAgent={sessionsByAgent}
              activeSessionId={sessionId}
              showArchivedMap={showArchived}
              onToggleShowArchived={toggleShowArchived}
              onAgentArchived={upsertAgent}
              onNewSession={startSession}
            />
          );
        })}
        {!showArchivedAgents && hiddenArchivedAgentCount > 0 && (
          <button
            onClick={toggleShowArchivedAgents}
            className="mt-1 flex items-center gap-1.5 px-3 py-1.5 w-full text-left text-xs rounded-md text-fg-muted hover:text-fg-secondary hover:bg-surface-1 transition-colors"
          >
            <Archive className="h-3 w-3" />
            {hiddenArchivedAgentCount} archived agent
            {hiddenArchivedAgentCount === 1 ? '' : 's'}
          </button>
        )}
        {showArchivedAgents && hasArchivedAgents && (
          <button
            onClick={toggleShowArchivedAgents}
            className="mt-1 flex items-center gap-1.5 px-3 py-1.5 w-full text-left text-xs rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-surface-1 transition-colors"
          >
            <Archive className="h-3 w-3" />
            hide archived agents
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
  expanded,
  onToggleAgent,
  machine,
  agents,
  sessionsByAgent,
  activeSessionId,
  showArchivedMap,
  onToggleShowArchived,
  onAgentArchived,
  onNewSession,
}: {
  project: ProjectGroup;
  open: boolean;
  onToggle: () => void;
  expanded: Record<string, boolean>;
  onToggleAgent: (key: string) => void;
  machine: MachineDTO | undefined;
  agents: Record<string, AgentDTO>;
  sessionsByAgent: Record<string, SessionDTO[]>;
  activeSessionId: string | undefined;
  showArchivedMap: Record<string, boolean>;
  onToggleShowArchived: (agentId: string) => void;
  onAgentArchived: (agent: AgentDTO) => void;
  onNewSession: (agentId: string) => void | Promise<void>;
}) {
  // Fall back to the agent's denormalized machine name if the Machine
  // row hasn't loaded yet (boot race between /agents and /machines).
  const fallbackMachineName = agents[project.agentIds[0]]?.machineName ?? project.machineId;
  const machineName = machine?.name ?? fallbackMachineName;
  const machineMeta = machine
    ? `${machine.hostname} · ${machine.os}/${machine.arch} · sidecar ${machine.sidecarVersion}`
    : machineName;
  const titleParts = [project.fullPath ?? 'agents without a workingDir', machineMeta];

  return (
    <div className="mb-0.5">
      <button
        onClick={onToggle}
        className="group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-1"
        title={titleParts.join(' · ')}
      >
        <ChevronRight
          className={cn('h-3 w-3 text-fg-tertiary transition-transform', open && 'rotate-90')}
        />
        {open ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-fg-tertiary" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-fg-tertiary" />
        )}
        <span className="min-w-0 truncate text-sm font-medium text-fg-primary">
          {project.label}
        </span>
        <MachineIconGlyph
          machineId={project.machineId}
          className="h-3 w-3 shrink-0 text-fg-muted"
        />
        <span className="ml-auto pl-1 text-meta text-fg-muted">{project.agentIds.length}</span>
      </button>

      {open && (
        <div className="ml-4 mt-0.5 border-l border-default pl-1">
          {project.agentIds.map((id) => {
            const a = agents[id];
            if (!a) return null;
            const agentSessions = sessionsByAgent[a.id] ?? [];
            const isOpen = expanded[a.id] !== false;
            const archivedVisible = showArchivedMap[a.id] ?? false;
            return (
              <AgentRow
                key={a.id}
                agent={a}
                sessions={agentSessions}
                activeSessionId={activeSessionId}
                open={isOpen}
                showArchived={archivedVisible}
                onToggle={() => onToggleAgent(a.id)}
                onNewSession={() => onNewSession(a.id)}
                onToggleArchived={() => onToggleShowArchived(a.id)}
                onAgentArchived={onAgentArchived}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Bottom-of-sidebar machine roster. Shows every host that has run
 * `argus-sidecar init` against this server, even ones currently
 * offline — so an operator can queue an agent on a machine before
 * it reconnects (the create-agent command is durably buffered on
 * the per-machine Redis stream). This is also the canonical entry
 * point for creating an agent on a machine that has no agents yet
 * (and therefore wouldn't appear in the project tree above).
 *
 * Hover a machine to reveal a `+` action that opens the
 * CreateAgentPopover. The popover is rendered inline next to the
 * row (not via a Portal) so its position naturally tracks the row
 * as the user scrolls the sidebar.
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
          {machine.agentCount} agent{machine.agentCount === 1 ? '' : 's'} · {adapters.length}{' '}
          adapter{adapters.length === 1 ? '' : 's'}
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
        title="create agent on this machine"
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
        <CreateAgentPopover machine={machine} anchor={anchorRef} onClose={onClosePopover} />
      )}
    </div>
  );
}

function SessionRow({ session, active }: { session: SessionDTO; active: boolean }) {
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

  const unread = !archived && session.status === 'done';
  const content = (
    <span className="flex items-center gap-1.5 min-w-0 flex-1">
      {!archived && session.status === 'active' && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
      )}
      {!archived && session.status === 'failed' && (
        <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
      )}
      {unread && (
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

function AgentRow({
  agent,
  sessions,
  activeSessionId,
  open,
  showArchived,
  onToggle,
  onNewSession,
  onToggleArchived,
  onAgentArchived,
}: {
  agent: AgentDTO;
  sessions: SessionDTO[];
  activeSessionId: string | undefined;
  open: boolean;
  showArchived: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onToggleArchived: () => void;
  onAgentArchived: (agent: AgentDTO) => void;
}) {
  const archived = !!agent.archivedAt;
  const [busy, setBusy] = useState(false);
  const visibleSessions = showArchived ? sessions : sessions.filter((s) => !s.archivedAt);
  const hiddenArchivedCount = sessions.length - visibleSessions.length;
  const hasArchived = sessions.some((s) => !!s.archivedAt);

  async function toggleAgentArchive(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const updated = archived
        ? await api.unarchiveAgent(agent.id)
        : await api.archiveAgent(agent.id);
      onAgentArchived(updated);
    } catch {
      /* swallow — toast surface not wired yet */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-0.5">
      <div
        className={cn(
          'group relative flex items-center rounded-md transition-colors hover:bg-surface-1',
          archived && 'opacity-70',
        )}
      >
        <button
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 pr-2 leading-5"
        >
          <ChevronRight
            className={cn('h-3 w-3 text-fg-tertiary transition-transform', open && 'rotate-90')}
          />
          <AgentTypeIcon type={agent.type} />
          <span
            className={cn(
              'min-w-0 truncate text-sm',
              archived ? 'text-fg-tertiary italic' : 'text-fg-primary',
            )}
            title={archived ? `${agent.name} (archived)` : agent.name}
          >
            {agent.name || agent.id}
          </span>
        </button>

        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <span
            aria-hidden
            className="absolute inset-y-0 right-full w-8 bg-gradient-to-r from-transparent to-surface-1"
          />
          <div className="flex items-center bg-surface-1">
            {!archived && agent.status !== 'offline' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onNewSession();
                }}
                className="flex items-center px-1.5 text-fg-muted transition-colors hover:text-fg-primary"
                title="new session"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={toggleAgentArchive}
              disabled={busy}
              className={cn(
                'flex items-center px-1.5 text-fg-muted transition-colors disabled:opacity-40 hover:text-fg-primary',
                archived && 'text-fg-tertiary',
              )}
              title={archived ? 'restore agent' : 'archive agent (hides from sidebar)'}
            >
              {archived ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
            </button>
            {!archived && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleArchived();
                }}
                className={cn(
                  'flex items-center px-2 transition-colors',
                  showArchived
                    ? 'text-emerald-400 hover:text-emerald-300'
                    : 'text-fg-muted hover:text-fg-secondary',
                )}
                title={
                  showArchived
                    ? 'hide archived sessions'
                    : hasArchived
                      ? `show ${hiddenArchivedCount} archived session${hiddenArchivedCount === 1 ? '' : 's'}`
                      : 'show archived sessions'
                }
              >
                {showArchived ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        </div>
      </div>

      {open && (
        <div className="ml-5 mt-0.5 border-l border-default pl-2 space-y-0.5">
          {visibleSessions.map((s) => (
            <SessionRow key={s.id} session={s} active={activeSessionId === s.id} />
          ))}
        </div>
      )}
    </div>
  );
}
