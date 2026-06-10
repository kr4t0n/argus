import { Link, useParams } from 'react-router-dom';
import { LogOut, PanelLeftOpen } from 'lucide-react';
import { MachineIconGlyph } from './MachineIcon';
import { ProjectIconGlyph } from './ProjectIcon';
import { useAgentStore } from '../stores/agentStore';
import { useMachineStore } from '../stores/machineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { useProjectStore } from '../stores/projectStore';
import { groupProjects } from '../lib/projects';
import { cn } from '../lib/utils';
import { StatusDot } from './ui/StatusDot';

/**
 * Thin (48px) rail shown in place of the full sidebar when the user
 * collapses it. Mirrors the main sidebar's project-first model: one
 * tile per project (folder or user-picked letter glyph), click jumps
 * to the project's most-recent non-archived session across any of
 * its agents. The machine strip below remains the canonical surface
 * for navigating directly to a host.
 *
 * Always hides archived projects + archived agents — the rail is for
 * "what am I working on now," not for unearthing history. The
 * synthetic "no project" bucket is also hidden: it has no path
 * identity, so a rail tile would be ambiguous and the user can't
 * make agents-without-workingDir anyway from the main sidebar.
 */
export function SidebarRail() {
  const { sessionId, machineId } = useParams();
  const agents = useAgentStore((s) => s.agents);
  const agentOrder = useAgentStore((s) => s.order);
  const sessions = useSessionStore((s) => s.sessions);
  const machines = useMachineStore((s) => s.machines);
  const machineOrder = useMachineStore((s) => s.order);
  const localProjects = useProjectStore((s) => s.projects);
  const localProjectOrder = useProjectStore((s) => s.order);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  // Rail is "active state" only — no archive visibility toggle.
  const visibleAgentOrder = agentOrder.filter((id) => !agents[id]?.archivedAt);
  const visibleLocalOrder = localProjectOrder.filter(
    (k) => !localProjects[k]?.archivedAt,
  );
  const projects = groupProjects(
    visibleAgentOrder,
    agents,
    localProjects,
    visibleLocalOrder,
  ).filter((p) => !!p.fullPath);

  // Most-recent non-archived session per project — same "land where
  // they'd expect" intent the old per-agent rail had, lifted one
  // level up. Walking all sessions is O(n) and N is small in
  // practice; not worth memoizing.
  const recentSessionByProject = new Map<string, string>();
  for (const s of Object.values(sessions)) {
    if (s.archivedAt) continue;
    const a = agents[s.agentId];
    if (!a || a.archivedAt) continue;
    const wd = (a.workingDir ?? '').trim();
    if (!wd) continue;
    const key = `${a.machineId}::${wd}`;
    const existing = recentSessionByProject.get(key);
    if (!existing || s.updatedAt > (sessions[existing]?.updatedAt ?? '')) {
      recentSessionByProject.set(key, s.id);
    }
  }

  // Highlight the project containing the currently-viewed session
  // (if any). Resolved through agent → workingDir + machineId to
  // match the project's key shape.
  let activeProjectKey: string | undefined;
  if (sessionId) {
    const s = sessions[sessionId];
    const a = s ? agents[s.agentId] : undefined;
    const wd = (a?.workingDir ?? '').trim();
    if (a && wd) activeProjectKey = `${a.machineId}::${wd}`;
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
        {projects.map((p) => {
          const recentId = recentSessionByProject.get(p.key);
          const active = p.key === activeProjectKey;
          const machine = machines[p.machineId];
          const tooltipParts = [p.label];
          if (p.fullPath) tooltipParts.push(p.fullPath);
          if (machine) tooltipParts.push(machine.name);
          const content = (
            <div
              title={tooltipParts.join(' · ')}
              className={cn(
                'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                active ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary hover:bg-surface-1',
                !recentId && 'opacity-50 cursor-not-allowed',
              )}
            >
              <ProjectIconGlyph
                iconKey={p.local?.iconKey}
                className="h-5 w-5 text-sm"
              />
            </div>
          );
          return recentId ? (
            <Link key={p.key} to={`/sessions/${recentId}`}>
              {content}
            </Link>
          ) : (
            <div key={p.key} role="button" aria-disabled>
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
