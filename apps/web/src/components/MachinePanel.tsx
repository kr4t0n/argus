import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowUpCircle, Loader2, Menu, Trash2 } from 'lucide-react';
import type { AvailableAdapter, SessionDTO } from '@argus/shared-types';
import { useMachineStore } from '../stores/machineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore, projectKey } from '../stores/projectStore';
import { useSidecarUpdateStore } from '../stores/sidecarUpdateStore';
import { api, ApiError } from '../lib/api';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';
import { ProjectIconGlyph } from './ProjectIcon';
import { MachineIconGlyph } from './MachineIcon';
import { Button } from './ui/Button';
import { basename } from '../lib/projects';
import { cn, relativeTime } from '../lib/utils';

/**
 * Right-pane "machine focus" view (/machines/:id): read-only host
 * metadata + installed adapters at the top, the machine's projects at
 * the bottom (each navigable to its most recent session). Reactive off
 * machineStore / projectStore.
 */
export function MachinePanel() {
  const { machineId } = useParams();
  const machine = useMachineStore((s) =>
    machineId ? s.machines[machineId] : undefined,
  );
  // Subscribe to the raw slices and compute the per-machine list with
  // useMemo. We can't subscribe to `s.forMachine(machineId)` directly:
  // it allocates a fresh array every call, and zustand's snapshot
  // (useSyncExternalStore) is invoked on every render — a never-equal
  // snapshot triggers React's "infinite update loop" bail-out and the
  // pane renders blank. Selecting the underlying maps and deriving in
  // a memo gives us a stable reference and a clean re-render only when
  // the inputs actually change.
  // Projects on this machine (Phase 4 — the machine's unit of work is
  // the project, not the agent). Non-archived rows from the server
  // project store, newest-updated first.
  const projectsMap = useProjectStore((s) => s.projects);
  const projects = useMemo(
    () =>
      Object.values(projectsMap)
        .filter((p) => p.machineId === machineId && !p.archivedAt)
        .sort((a, b) => (a.name ?? a.workingDir).localeCompare(b.name ?? b.workingDir)),
    [projectsMap, machineId],
  );
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  // Refresh the per-machine version badge whenever the panel mounts or the
  // sidecar reports a new version (the latter typically lands via WS after
  // a successful remote update — at which point the cached "update
  // available" boolean is stale and should be re-checked).
  const setVersionInfo = useSidecarUpdateStore((s) => s.setVersionInfo);
  useEffect(() => {
    if (!machineId || !machine) return;
    let cancelled = false;
    api
      .getSidecarVersion(machineId)
      .then((info) => {
        if (!cancelled) setVersionInfo(machineId, info);
      })
      .catch(() => {
        // best-effort badge: stay quiet on errors (offline machine,
        // GH rate limit, etc.)
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, machine?.sidecarVersion, setVersionInfo, machine]);

  if (!machineId) return null;
  if (!machine) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-tertiary">
        machine not found
      </div>
    );
  }

  const adapters = (machine.availableAdapters ?? []) as AvailableAdapter[];

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 shrink-0 flex items-center gap-3 px-5 md:hidden">
        <button
          onClick={toggleSidebar}
          className="text-fg-tertiary hover:text-fg-primary transition-colors"
          title="show sidebar"
          aria-label="show sidebar"
        >
          <Menu className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-10 py-10 no-scrollbar">
        <div className="mx-auto max-w-6xl space-y-12">
          <header className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-surface-1 text-fg-secondary">
              <MachineIconGlyph machineId={machine.id} className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <h1 className="truncate font-display text-3xl font-semibold tracking-tight text-fg-primary">
                  {machine.name}
                </h1>
                <StatusDot status={machine.status === 'online' ? 'online' : 'offline'} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <SidecarUpdateAction machineId={machineId} machineName={machine.name} />
              <DeleteMachineAction machineId={machineId} machineName={machine.name} />
            </div>
          </header>

          <div className="grid gap-x-20 gap-y-10 md:grid-cols-[2fr_3fr]">
            <div className="space-y-10">
              <Section title="Host">
                <div className="space-y-1">
                  <KV k="id" v={<span className="font-mono">{machine.id}</span>} />
                  <KV
                    k="hostname"
                    v={<span className="font-mono">{machine.hostname}</span>}
                  />
                  <KV k="os" v={`${machine.os}/${machine.arch}`} />
                  <KV
                    k="sidecar"
                    v={<span className="font-mono">{machine.sidecarVersion}</span>}
                  />
                  <KV
                    k="registered"
                    v={
                      <span title={machine.registeredAt}>
                        {relativeTime(machine.registeredAt)} ago
                      </span>
                    }
                  />
                  <KV
                    k="last seen"
                    v={
                      <span title={machine.lastSeenAt}>
                        {relativeTime(machine.lastSeenAt)} ago
                      </span>
                    }
                  />
                </div>
              </Section>

              <SupportsFooter adapters={adapters} />
            </div>

            <Section title={`Projects · ${projects.length}`}>
              {projects.length === 0 ? (
                <div className="text-meta">
                  no projects on this machine yet — create one from the sidebar.
                </div>
              ) : (
                <ul className="-mx-2 divide-y divide-default/40">
                  {projects.map((p) => (
                    <ProjectLine
                      key={p.id}
                      machineId={machine.id}
                      projectId={p.id}
                      name={p.name || basename(p.workingDir)}
                      workingDir={p.workingDir}
                    />
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function SupportsFooter({ adapters }: { adapters: AvailableAdapter[] }) {
  if (adapters.length === 0) {
    return (
      <Section title="Supports">
        <div className="text-meta">no CLI adapters detected on this host's PATH</div>
      </Section>
    );
  }
  return (
    <Section title="Supports">
      <ul className="space-y-1.5 text-xs text-fg-secondary">
        {adapters.map((a) => (
          <li
            key={a.type}
            className="flex items-center gap-2"
            title={a.binary + (a.version ? ` · ${a.version}` : '')}
          >
            <AgentTypeIcon type={a.type} size={14} />
            <span>{agentTypeLabel(a.type)}</span>
            {a.version && (
              <span className="ml-auto font-mono text-[11px] text-fg-tertiary">
                {a.version}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs leading-6">
      <span className="text-fg-tertiary">{k}</span>
      <span className="max-w-[70%] truncate text-right text-fg-primary">{v}</span>
    </div>
  );
}

/** One project row on the machine panel — navigates to its most recent
 *  session (projects have no route of their own). */
function ProjectLine({
  machineId,
  projectId,
  name,
  workingDir,
}: {
  machineId: string;
  projectId: string;
  name: string;
  workingDir: string;
}) {
  const navigate = useNavigate();
  const sessions = useSessionStore((s) => s.sessions);
  const iconKey = useProjectStore((s) => s.serverIcons[projectKey(machineId, workingDir)]);

  const recent: SessionDTO | undefined = useMemo(() => {
    const mine = Object.values(sessions).filter((s) => s.projectId === projectId && !s.archivedAt);
    if (mine.length === 0) return undefined;
    return mine.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  }, [sessions, projectId]);

  const count = useMemo(
    () => Object.values(sessions).filter((s) => s.projectId === projectId && !s.archivedAt).length,
    [sessions, projectId],
  );

  function jump() {
    if (recent) navigate(`/sessions/${recent.id}`);
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={jump}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            jump();
          }
        }}
        className={cn(
          'group flex w-full items-start gap-3 rounded-md px-2 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary',
          recent ? 'hover:bg-surface-1 cursor-pointer' : 'cursor-default',
        )}
      >
        <ProjectIconGlyph
          iconKey={iconKey}
          className="mt-0.5 h-4 w-4 shrink-0 text-[13px] text-fg-secondary"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-fg-primary">{name}</span>
            <span className="ml-auto truncate font-mono text-[11px] text-fg-tertiary">
              {trimDir(workingDir)}
            </span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-2 text-meta">
            <span>
              {count} session{count === 1 ? '' : 's'}
            </span>
            <span className="ml-auto truncate text-fg-muted">
              {recent ? `last active ${relativeTime(recent.updatedAt)} ago` : 'no sessions yet'}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

function trimDir(abs: string): string {
  const home = abs.match(/^\/Users\/[^/]+\/(.+)$/);
  if (home) return '~/' + home[1];
  return abs;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-caps">{title}</h2>
      <div>{children}</div>
    </section>
  );
}

/**
 * Clickable "update available" badge next to the machine title. Reads
 * from the cached version info populated by MachinePanel's effect (we
 * don't fetch here so multiple consumers share the cache) and doubles
 * as the trigger for the remote sidecar update — clicking it kicks off
 * the same flow that used to live behind the kebab menu.
 *
 * Update flow:
 *   1. user clicks → confirm dialog
 *   2. POST /machines/:id/sidecar/update → 202 Accepted
 *   3. store.begin() seeds a 'pending' toast
 *   4. WS lifecycle events flip the toast through started → downloaded
 *      → completed (or failed). MachinePanel's useEffect refetches the
 *      version badge once the machine re-registers with the new tag,
 *      which causes this component to unmount once `updateAvailable`
 *      flips back to false.
 */
function SidecarUpdateAction({
  machineId,
  machineName,
}: {
  machineId: string;
  machineName: string;
}) {
  const machine = useMachineStore((s) => s.machines[machineId]);
  const info = useSidecarUpdateStore((s) => s.versions[machineId]);
  const update = useSidecarUpdateStore((s) => s.updates[machineId]);
  const begin = useSidecarUpdateStore((s) => s.begin);
  const setFailed = useSidecarUpdateStore((s) => s.setFailed);

  if (!info?.updateAvailable || !info.latest) return null;

  const offline = machine?.status === 'offline';
  // Anything pre-completed/pre-failed counts as "in flight" — the
  // server's single-flight guard would reject a duplicate anyway, but
  // disabling the badge gives clearer feedback.
  const inFlight =
    !!update && update.phase !== 'completed' && update.phase !== 'failed';

  async function doUpdate() {
    if (offline || inFlight || !info?.latest) return;
    const current = info.current ?? machine?.sidecarVersion ?? 'unknown';
    const msg = `Update sidecar on "${machineName}" from ${current} to ${info.latest}?\n\nThe sidecar will download the new binary and restart. Active sessions stay connected (the daemon re-attaches on restart).`;
    if (!confirm(msg)) return;
    begin(machineId, machineName, current);
    try {
      await api.updateSidecar(machineId);
      // Server returns 202 immediately — toast progression is driven
      // entirely by WS lifecycle events from here on.
    } catch (ex) {
      setFailed(machineId, current, ex instanceof ApiError ? ex.message : 'failed to start update');
    }
  }

  const title = offline
    ? `machine offline — update ${info.latest} available when it reconnects`
    : inFlight
      ? `update to ${info.latest} in progress…`
      : `update sidecar from ${info.current} to ${info.latest}`;

  return (
    <Button
      size="md"
      variant="outline"
      onClick={doUpdate}
      disabled={offline || inFlight}
      title={title}
    >
      {inFlight ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowUpCircle className="h-3.5 w-3.5" />
      )}
      Update <span className="font-mono text-[11px] text-fg-tertiary">{info.latest}</span>
    </Button>
  );
}

/**
 * Destructive "delete machine" button in the panel header, beside
 * "new agent". Soft-deletes the machine: it disappears from every
 * dashboard and its agents are hidden, but NO data is destroyed —
 * all session history stays in Postgres and remains viewable through
 * the (user-scoped) session list. The server-side tombstone is
 * sticky, so this is safe at any status: a still-running or
 * restarting sidecar can't bring the machine back. Terminal by
 * design — there is no un-delete from the UI.
 *
 * On success we navigate to the dashboard root: the row is gone, so
 * `/machines/:id` would otherwise render the "machine not found"
 * placeholder. The `machine:removed` WS event drops it from every
 * store; the local `remove()` just avoids a one-frame flash here.
 */
function DeleteMachineAction({
  machineId,
  machineName,
}: {
  machineId: string;
  machineName: string;
}) {
  const navigate = useNavigate();
  const removeMachine = useMachineStore((s) => s.remove);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function doDelete() {
    if (busy) return;
    const msg =
      `Delete machine "${machineName}"?\n\n` +
      `It will be removed from the dashboard and its agents hidden, ` +
      `but all session history is kept and stays viewable. ` +
      `This can't be undone from the UI.`;
    if (!confirm(msg)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.deleteMachine(machineId);
      removeMachine(machineId);
      navigate('/');
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : 'failed to delete machine');
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <Button
        size="md"
        variant="danger"
        onClick={doDelete}
        disabled={busy}
        title={`delete machine "${machineName}"`}
        aria-label={`Delete machine ${machineName}`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
        delete
      </Button>
      {err && (
        <span className="absolute right-0 top-full mt-1 whitespace-nowrap text-[11px] text-red-500 dark:text-red-400">
          {err}
        </span>
      )}
    </div>
  );
}

