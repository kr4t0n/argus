import { Link, useParams, useNavigate } from 'react-router-dom';
import { LogOut, PanelLeftOpen } from 'lucide-react';
import { MachineIconGlyph } from './MachineIcon';
import { useAgentStore } from '../stores/agentStore';
import { useMachineStore } from '../stores/machineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { cn } from '../lib/utils';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';

/**
 * Thin (48px) rail shown in place of the full sidebar when the user
 * collapses it. Renders one icon per non-archived agent (jumps to its
 * most-recent session on click) and one per machine. Keeps the expand
 * button + logout reachable so the user never loses the escape hatch.
 */
export function SidebarRail() {
  const { sessionId, machineId } = useParams();
  const nav = useNavigate();
  const agents = useAgentStore((s) => s.agents);
  const order = useAgentStore((s) => s.order);
  const sessions = useSessionStore((s) => s.sessions);
  const machines = useMachineStore((s) => s.machines);
  const machineOrder = useMachineStore((s) => s.order);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  const activeAgentId = sessionId ? sessions[sessionId]?.agentId : undefined;

  // Pick the most-recent non-archived session per agent so an icon
  // click drops the user straight into the conversation they'd expect.
  const recentSessionByAgent = new Map<string, string>();
  for (const s of Object.values(sessions)) {
    if (s.archivedAt) continue;
    const existing = recentSessionByAgent.get(s.agentId);
    if (!existing || s.updatedAt > sessions[existing].updatedAt) {
      recentSessionByAgent.set(s.agentId, s.id);
    }
  }

  const visibleAgents = order
    .map((id) => agents[id])
    .filter((a): a is NonNullable<typeof a> => !!a && !a.archivedAt);

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
        {visibleAgents.map((a) => {
          const sid = recentSessionByAgent.get(a.id);
          const active = a.id === activeAgentId;
          const content = (
            <div
              title={`${a.name} · ${agentTypeLabel(a.type)}`}
              className={cn(
                'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                active ? 'bg-surface-2' : 'hover:bg-surface-1',
                !sid && 'opacity-50 cursor-not-allowed',
              )}
            >
              <AgentTypeIcon type={a.type} size={18} />
              <span className="absolute -bottom-0.5 -right-0.5">
                <StatusDot status={a.status} />
              </span>
            </div>
          );
          return sid ? (
            <Link key={a.id} to={`/sessions/${sid}`}>
              {content}
            </Link>
          ) : (
            <div
              key={a.id}
              role="button"
              onClick={() => nav(`/`)}
              aria-disabled
            >
              {content}
            </div>
          );
        })}
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
