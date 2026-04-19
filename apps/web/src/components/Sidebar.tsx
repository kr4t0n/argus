import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Eye,
  EyeOff,
  LogOut,
  Pencil,
  Plus,
} from 'lucide-react';
import type { AgentDTO, SessionDTO } from '@argus/shared-types';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { cn, relativeTime } from '../lib/utils';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';
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
        <button
          onClick={logout}
          className="text-neutral-500 hover:text-neutral-200 transition-colors"
          title={user?.email ?? 'sign out'}
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-1">
        {order.length === 0 && (
          <div className="px-4 py-6 text-xs text-neutral-500">
            No agents registered yet. Start a sidecar with <code>./sidecar --config …</code>.
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
    </aside>
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
            {agent.id}{' '}
            <span className="text-neutral-500">· {agent.machine}</span>
          </span>
          <span className="ml-auto flex items-center gap-2">
            {visibleSessions.length > 0 && (
              <span className="text-[10px] text-neutral-500">
                {visibleSessions.length}
              </span>
            )}
            <StatusDot status={agent.status} />
          </span>
        </button>
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
      </div>

      {open && (
        <div className="ml-5 mt-0.5 border-l border-neutral-900 pl-2 space-y-0.5">
          {visibleSessions.map((s) => (
            <SessionRow key={s.id} session={s} active={activeSessionId === s.id} />
          ))}
          {!showArchived && hiddenArchivedCount > 0 && (
            <button
              onClick={onToggleArchived}
              className="flex items-center gap-1.5 px-2 py-1 w-full text-left text-[11px] rounded-md text-neutral-600 hover:text-neutral-300 hover:bg-neutral-900 transition-colors"
            >
              <Archive className="h-3 w-3" />
              {hiddenArchivedCount} archived
            </button>
          )}
          <button
            onClick={onNewSession}
            disabled={agent.status === 'offline' || archived}
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 w-full text-left text-xs rounded-md transition-colors',
              'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-900',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
            )}
            title={archived ? 'restore the agent before starting a new session' : undefined}
          >
            <Plus className="h-3 w-3" />
            new session
          </button>
        </div>
      )}
    </div>
  );
}
