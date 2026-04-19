import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Server, Trash2 } from 'lucide-react';
import type { AgentDTO, AvailableAdapter } from '@argus/shared-types';
import { useMachineStore } from '../stores/machineStore';
import { useAgentStore } from '../stores/agentStore';
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
        <Server className="h-4 w-4 text-neutral-400" />
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-sm font-medium text-neutral-100 truncate">
            {machine.name}
          </div>
          <span className="text-xs text-neutral-500 truncate">
            · {machine.os}/{machine.arch} · sidecar {machine.sidecarVersion}
          </span>
          <StatusDot status={machine.status === 'online' ? 'online' : 'offline'} />
        </div>
        <div ref={createBtnRef} className="ml-auto relative">
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

