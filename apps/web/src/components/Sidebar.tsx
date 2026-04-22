import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ArrowUpCircle,
  ChevronRight,
  Eye,
  EyeOff,
  LogOut,
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
import { useAuthStore } from '../stores/authStore';
import { useSidecarUpdateStore } from '../stores/sidecarUpdateStore';
import { cn, relativeTime } from '../lib/utils';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';
import { CreateAgentPopover } from './CreateAgentPopover';
import { BulkUpdateModal } from './BulkUpdateModal';
import { MachineIcon } from './MachineIcon';
import { api } from '../lib/api';

export function Sidebar() {
  const { sessionId } = useParams();
  const nav = useNavigate();
  const agents = useAgentStore((s) => s.agents);
  const order = useAgentStore((s) => s.order);
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
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

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

  return (
    <aside className="h-full w-full flex flex-col border-r border-neutral-900 bg-neutral-950">
      <div className="h-12 shrink-0 px-4 border-b border-neutral-900 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
          <span className="text-sm font-semibold tracking-tight">Argus</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleSidebar}
            className="text-neutral-500 hover:text-neutral-200 transition-colors"
            title="hide sidebar"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={logout}
            className="text-neutral-500 hover:text-neutral-200 transition-colors"
            title={user?.email ?? 'sign out'}
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-1">
        {order.length === 0 && (
          <div className="px-4 py-6 text-xs text-neutral-500">
            No agents yet — hover a machine below and click{' '}
            <Plus className="inline h-3 w-3 -mt-0.5" /> to create one.
          </div>
        )}
        {(() => {
          const visibleOrder = showArchivedAgents
            ? order
            : order.filter((id) => !agents[id]?.archivedAt);
          const hiddenArchivedAgentCount = order.length - visibleOrder.length;
          return (
            <>
              {visibleOrder.map((id) => {
                const a = agents[id];
                if (!a) return null;
                const agentSessions = sessionsByAgent[a.id] ?? [];
                const isOpen = expanded[a.id] !== false;
                const archivedVisible = showArchived[a.id] ?? false;
                return (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    sessions={agentSessions}
                    activeSessionId={sessionId}
                    open={isOpen}
                    showArchived={archivedVisible}
                    onToggle={() => toggle(a.id)}
                    onNewSession={() => startSession(a.id)}
                    onToggleArchived={() => toggleShowArchived(a.id)}
                    onAgentArchived={upsertAgent}
                  />
                );
              })}
              {!showArchivedAgents && hiddenArchivedAgentCount > 0 && (
                <button
                  onClick={toggleShowArchivedAgents}
                  className="mt-1 flex items-center gap-1.5 px-3 py-1.5 w-full text-left text-[11px] rounded-md text-neutral-600 hover:text-neutral-300 hover:bg-neutral-900 transition-colors"
                >
                  <Archive className="h-3 w-3" />
                  {hiddenArchivedAgentCount} archived agent
                  {hiddenArchivedAgentCount === 1 ? '' : 's'}
                </button>
              )}
              {showArchivedAgents && order.some((id) => agents[id]?.archivedAt) && (
                <button
                  onClick={toggleShowArchivedAgents}
                  className="mt-1 flex items-center gap-1.5 px-3 py-1.5 w-full text-left text-[11px] rounded-md text-emerald-400 hover:text-emerald-300 hover:bg-neutral-900 transition-colors"
                >
                  <Archive className="h-3 w-3" />
                  hide archived agents
                </button>
              )}
            </>
          );
        })()}
      </div>

      <MachineList />
    </aside>
  );
}

/**
 * Bottom-of-sidebar machine roster. Shows every host that has run
 * `argus-sidecar init` against this server, even ones currently
 * offline — so an operator can queue an agent on a machine before
 * it reconnects (the create-agent command is durably buffered on
 * the per-machine Redis stream).
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
      <div className="shrink-0 px-4 py-3 text-[11px] text-neutral-600">
        no machines connected. Run{' '}
        <code className="rounded bg-neutral-900 px-1 py-0.5 text-neutral-400">
          argus-sidecar init
        </code>{' '}
        on a host.
      </div>
    );
  }

  return (
    <div className="shrink-0 py-1.5 px-1 max-h-[40%] overflow-y-auto">
      <div className="group flex items-center px-3 py-1">
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          machines
        </span>
        <span className="ml-1.5 text-[10px] text-neutral-700">
          ({order.length})
        </span>
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
        className="rounded p-0.5 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
        title="machine actions"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 shadow-lg">
          <button
            onClick={() => {
              setOpen(false);
              setShowModal(true);
            }}
            disabled={batchInFlight}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-xs',
              'text-neutral-200 hover:bg-neutral-900',
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
        'group flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-neutral-900',
        active && 'bg-neutral-900',
        offline && 'opacity-60',
      )}
    >
      <MachineIcon machineId={machine.id} className="text-neutral-500" />
      <Link
        to={`/machines/${machine.id}`}
        className="min-w-0 flex-1 outline-none"
      >
        <div
          className="truncate text-[12px] text-neutral-200"
          title={`${machine.hostname} · ${machine.os}/${machine.arch} · sidecar ${machine.sidecarVersion}`}
        >
          {machine.name}
        </div>
        <div className="truncate text-[10px] text-neutral-600">
          {machine.agentCount} agent{machine.agentCount === 1 ? '' : 's'} ·{' '}
          {adapters.length} adapter{adapters.length === 1 ? '' : 's'}
        </div>
      </Link>
      <StatusDot status={machine.status === 'online' ? 'online' : 'offline'} />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpenPopover();
        }}
        className={cn(
          'ml-0.5 flex items-center text-neutral-500 transition-opacity hover:text-neutral-200',
          popoverOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        title="create agent on this machine"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {popoverOpen && (
        <CreateAgentPopover
          machine={machine}
          anchor={anchorRef}
          onClose={onClosePopover}
        />
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

  const content = (
    <span className="flex items-center gap-1.5 min-w-0 flex-1">
      {!archived && session.status === 'active' && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
      )}
      {!archived && session.status === 'failed' && (
        <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
      )}
      {archived && (
        <Archive className="h-3 w-3 shrink-0 text-neutral-600" />
      )}
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
          className="min-w-0 flex-1 rounded bg-neutral-800 px-1 py-0.5 text-sm text-neutral-100 outline-none ring-1 ring-neutral-700 focus:ring-neutral-500"
        />
      ) : (
        <span
          className={cn(
            'truncate',
            archived ? 'text-neutral-500 italic' : 'text-neutral-300',
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
            className="text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:text-neutral-200"
            title="rename session"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            onClick={toggleArchive}
            disabled={busy}
            className={cn(
              'text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:text-neutral-200 disabled:opacity-40',
              archived && 'opacity-100 text-neutral-500',
            )}
            title={archived ? 'restore from archive' : 'archive session'}
          >
            {archived ? (
              <ArchiveRestore className="h-3 w-3" />
            ) : (
              <Archive className="h-3 w-3" />
            )}
          </button>
        </>
      )}
      <span className="text-[10px] text-neutral-600">{relativeTime(session.updatedAt)}</span>
    </span>
  );

  const rowClass = cn(
    'group flex items-center justify-between rounded-md px-2 py-1 text-sm transition-colors hover:bg-neutral-900',
    active && 'bg-neutral-900 text-neutral-50',
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
  const visibleSessions = showArchived
    ? sessions
    : sessions.filter((s) => !s.archivedAt);
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
    <div className="mb-1">
      <div
        className={cn(
          'group flex items-stretch rounded-md hover:bg-neutral-900 transition-colors',
          archived && 'opacity-70',
        )}
      >
        <button
          onClick={onToggle}
          className="flex flex-1 min-w-0 items-center gap-1.5 px-2.5 py-1.5"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 text-neutral-500 transition-transform',
              open && 'rotate-90',
            )}
          />
          <AgentTypeIcon type={agent.type} />
          <span
            className={cn(
              'text-sm truncate',
              archived ? 'text-neutral-400 italic' : 'text-neutral-200',
            )}
            title={archived ? `${agentTypeLabel(agent.type)} (archived)` : agentTypeLabel(agent.type)}
          >
            {agent.name || agent.id}{' '}
            <span className="text-neutral-500">· {agent.machineName}</span>
          </span>
        </button>
        {/* New-session action, hover-only. Hidden when the agent is
            archived or offline since the create would be rejected anyway. */}
        {!archived && agent.status !== 'offline' && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onNewSession();
            }}
            className="flex items-center px-1.5 text-neutral-600 opacity-0 transition-colors hover:text-neutral-200 group-hover:opacity-100"
            title="new session"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {/* Per-agent archive toggle (for the AGENT itself). */}
        <button
          onClick={toggleAgentArchive}
          disabled={busy}
          className={cn(
            'flex items-center px-1.5 text-neutral-600 transition-colors disabled:opacity-40',
            archived
              ? 'opacity-100 text-neutral-500 hover:text-neutral-200'
              : 'opacity-0 group-hover:opacity-100 hover:text-neutral-200',
          )}
          title={archived ? 'restore agent' : 'archive agent (hides from sidebar)'}
        >
          {archived ? (
            <ArchiveRestore className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </button>
        {/* Per-agent VISIBILITY toggle for archived child sessions.
            Uses an eye icon (rather than the archive box) so it can sit next
            to the archive-agent action without two identical glyphs colliding.
            Hidden when the agent itself is archived to reduce visual noise. */}
        {!archived && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleArchived();
            }}
            className={cn(
              'flex items-center px-2 transition-colors',
              // The eye toggle is always visible whenever there's something
              // archived to look at OR the user has it currently on; otherwise
              // it stays hover-only so the row reads cleanly at rest.
              (showArchived || hasArchived)
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100',
              showArchived
                ? 'text-emerald-400 hover:text-emerald-300'
                : 'text-neutral-600 hover:text-neutral-300',
            )}
            title={
              showArchived
                ? 'hide archived sessions'
                : hasArchived
                  ? `show ${hiddenArchivedCount} archived session${hiddenArchivedCount === 1 ? '' : 's'}`
                  : 'show archived sessions'
            }
          >
            {showArchived ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {/* Liveness dot — pinned to the rightmost slot so it reads as a
            persistent status indicator. The hover-revealed action icons
            (+ archive eye) sit to its left. */}
        <span className="flex items-center pr-2">
          <StatusDot status={agent.status} />
        </span>
      </div>

      {open && (
        <div className="ml-5 mt-0.5 border-l border-neutral-900 pl-2 space-y-0.5">
          {visibleSessions.map((s) => (
            <SessionRow key={s.id} session={s} active={activeSessionId === s.id} />
          ))}
        </div>
      )}
    </div>
  );
}
