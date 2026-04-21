import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowUpCircle, Loader2, Menu, Server, Trash2 } from 'lucide-react';
import type { AgentDTO, AvailableAdapter } from '@argus/shared-types';
import { useMachineStore } from '../stores/machineStore';
import { useAgentStore } from '../stores/agentStore';
import { useUIStore } from '../stores/uiStore';
import { useSidecarUpdateStore } from '../stores/sidecarUpdateStore';
import { api, ApiError } from '../lib/api';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';
import { CreateAgentPopover } from './CreateAgentPopover';
import { Button } from './ui/Button';
import { cn, relativeTime } from '../lib/utils';

/**
 * Right-pane "machine focus" view. Shown at /machines/:id when a user
 * clicks through from the sidebar machine row. Mirrors the structure
 * of the per-session ContextPane: read-only metadata at the top,
 * actionable list of agents at the bottom.
 *
 * The view is reactive — it reads straight from machineStore /
 * agentStore so machine-status flips and freshly created agents
 * appear without a refetch.
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
  const agentsMap = useAgentStore((s) => s.agents);
  const agentOrder = useAgentStore((s) => s.order);
  const agents = useMemo(
    () =>
      machineId
        ? agentOrder.map((id) => agentsMap[id]!).filter((a) => a && a.machineId === machineId)
        : [],
    [machineId, agentsMap, agentOrder],
  );
  const [showCreate, setShowCreate] = useState(false);
  const createBtnRef = useRef<HTMLDivElement>(null);
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
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        machine not found
      </div>
    );
  }

  const adapters = (machine.availableAdapters ?? []) as AvailableAdapter[];

  return (
    <div className="flex h-full flex-col">
      <div className="h-12 shrink-0 flex items-center gap-3 px-5 border-b border-neutral-900">
        <button
          onClick={toggleSidebar}
          className="md:hidden text-neutral-500 hover:text-neutral-200 transition-colors"
          title="show sidebar"
        >
          <Menu className="h-4 w-4" />
        </button>
        <Server className="h-4 w-4 text-neutral-400" />
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-sm font-medium text-neutral-100 truncate">
            {machine.name}
          </div>
          <span className="text-xs text-neutral-500 truncate">
            · {machine.os}/{machine.arch} · sidecar {machine.sidecarVersion}
          </span>
          <SidecarVersionBadge machineId={machineId} machineName={machine.name} />
          <StatusDot status={machine.status === 'online' ? 'online' : 'offline'} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div ref={createBtnRef} className="relative">
            <Button
              size="sm"
              variant="subtle"
              onClick={() => setShowCreate((v) => !v)}
              disabled={machine.status === 'offline'}
            >
              new agent
            </Button>
            {showCreate && (
              <CreateAgentPopover
                machine={machine}
                anchor={createBtnRef}
                onClose={() => setShowCreate(false)}
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        <Section title="Host">
          <KV k="hostname" v={<span className="font-mono">{machine.hostname}</span>} />
          <KV k="os" v={machine.os} />
          <KV k="arch" v={machine.arch} />
          <KV k="sidecar" v={machine.sidecarVersion} />
          <KV
            k="registered"
            v={<span title={machine.registeredAt}>{relativeTime(machine.registeredAt)} ago</span>}
          />
          <KV
            k="last seen"
            v={<span title={machine.lastSeenAt}>{relativeTime(machine.lastSeenAt)} ago</span>}
          />
        </Section>

        <Section title={`Available adapters (${adapters.length})`}>
          {adapters.length === 0 ? (
            <div className="text-[11px] text-neutral-500">
              no CLI adapters detected on this host's PATH
            </div>
          ) : (
            <ul className="space-y-1">
              {adapters.map((a) => (
                <li
                  key={a.type}
                  className="flex items-center gap-2 text-[12px] text-neutral-300"
                >
                  <AgentTypeIcon type={a.type} />
                  <span>{agentTypeLabel(a.type)}</span>
                  <span className="ml-auto font-mono text-[10px] text-neutral-500">
                    {a.binary}
                    {a.version && ` · ${a.version}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Agents (${agents.length})`}>
          {agents.length === 0 ? (
            <div className="text-[11px] text-neutral-500">no agents on this machine yet</div>
          ) : (
            <ul className="space-y-1">
              {agents.map((a) => (
                <AgentLine key={a.id} machineId={machine.id} agent={a} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function AgentLine({ machineId, agent }: { machineId: string; agent: AgentDTO }) {
  const removeAgent = useAgentStore((s) => s.remove);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function destroy() {
    if (busy) return;
    if (!confirm(`Destroy agent "${agent.name}"? This deletes its sessions and history.`)) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.destroyAgent(machineId, agent.id);
      removeAgent(agent.id);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'failed to destroy');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-neutral-900">
      <AgentTypeIcon type={agent.type} />
      <span className="truncate text-[12px] text-neutral-200">{agent.name}</span>
      <span className="truncate text-[10px] text-neutral-500">
        · {agentTypeLabel(agent.type)}
      </span>
      <span className="ml-auto flex items-center gap-2">
        {err && <span className="text-[10px] text-red-400">{err}</span>}
        <StatusDot status={agent.status} />
        <button
          onClick={destroy}
          disabled={busy}
          className={cn(
            'text-neutral-600 transition-opacity hover:text-red-400 disabled:opacity-40',
            'opacity-0 group-hover:opacity-100',
          )}
          title="destroy agent (irreversible)"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </span>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-neutral-600 mb-2">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-neutral-500">{k}</span>
      <span className="text-neutral-200 truncate max-w-[60%]">{v}</span>
    </div>
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
function SidecarVersionBadge({
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
    } catch (e) {
      const reason =
        e instanceof ApiError ? e.message : 'failed to start update';
      setFailed(machineId, current, reason);
    }
  }

  const title = offline
    ? `machine is offline — sidecar update ${info.latest} available`
    : inFlight
      ? `update to ${info.latest} in progress…`
      : `click to update sidecar to ${info.latest} (current: ${info.current})`;

  return (
    <button
      type="button"
      onClick={doUpdate}
      disabled={offline || inFlight}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-emerald-700/60 bg-emerald-900/30 px-1.5 py-[1px] text-[10px] font-medium text-emerald-300 transition-colors',
        'hover:border-emerald-500/70 hover:bg-emerald-800/50 hover:text-emerald-100',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-emerald-700/60 disabled:hover:bg-emerald-900/30 disabled:hover:text-emerald-300',
      )}
    >
      {inFlight ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <ArrowUpCircle className="h-3 w-3" />
      )}
      {info.latest}
    </button>
  );
}

