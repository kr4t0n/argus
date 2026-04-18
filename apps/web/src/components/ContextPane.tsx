import type { AgentDTO, SessionDTO, CommandDTO } from '@argus/shared-types';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';
import { StatusDot } from './ui/StatusDot';
import { relativeTime } from '../lib/utils';

type Props = {
  agent: AgentDTO | undefined;
  session: SessionDTO | undefined;
  recentCommands: CommandDTO[];
};

export function ContextPane({ agent, session, recentCommands }: Props) {
  if (!agent) {
    return <div className="h-full p-4 text-sm text-neutral-500">no agent selected</div>;
  }
  return (
    <aside className="h-full w-full border-l border-neutral-900 bg-neutral-950 px-4 py-4 overflow-y-auto">
      <Section title="Agent">
        <div className="flex items-center gap-2">
          <AgentTypeIcon type={agent.type} />
          <span className="text-sm text-neutral-100">{agentTypeLabel(agent.type)}</span>
        </div>
        <KV k="machine" v={agent.machine} />
        <KV
          k="status"
          v={
            <span className="inline-flex items-center gap-1.5">
              <StatusDot status={agent.status} />
              <span>{agent.status}</span>
            </span>
          }
        />
        <KV k="version" v={agent.version ?? '—'} />
        {agent.workingDir && (
          <KV
            k="working dir"
            v={
              <span
                title={agent.workingDir}
                className="font-mono text-[11px] text-neutral-300"
              >
                {agent.workingDir}
              </span>
            }
          />
        )}
        <KV
          k="registered"
          v={<span title={agent.registeredAt}>{relativeTime(agent.registeredAt)} ago</span>}
        />
        <KV
          k="last seen"
          v={
            <span title={agent.lastHeartbeatAt}>{relativeTime(agent.lastHeartbeatAt)} ago</span>
          }
        />
      </Section>

      {agent.capabilities.length > 0 && (
        <Section title="Capabilities">
          <div className="flex flex-wrap gap-1 mt-1">
            {agent.capabilities.map((c) => (
              <span
                key={c}
                className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-md bg-neutral-900 border border-neutral-800 text-neutral-400"
              >
                {c}
              </span>
            ))}
          </div>
        </Section>
      )}

      {session && (
        <Section title="Session">
          <KV k="title" v={session.title} />
          <KV k="status" v={session.status} />
          {session.externalId && <KV k="external id" v={session.externalId} />}
          <KV
            k="updated"
            v={<span title={session.updatedAt}>{relativeTime(session.updatedAt)} ago</span>}
          />
        </Section>
      )}

      {recentCommands.length > 0 && (
        <Section title="Recent turns">
          <ul className="space-y-1 mt-1">
            {recentCommands.slice(-5).reverse().map((c) => (
              <li
                key={c.id}
                className="text-[11px] text-neutral-400 flex items-center gap-1.5"
              >
                <span
                  className={
                    c.status === 'failed'
                      ? 'text-red-400'
                      : c.status === 'completed'
                        ? 'text-emerald-400'
                        : c.status === 'cancelled'
                          ? 'text-neutral-500'
                          : 'text-amber-300'
                  }
                >
                  ●
                </span>
                <span className="truncate">{c.prompt ?? `(${c.kind})`}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-widest text-neutral-600 mb-1.5">
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
