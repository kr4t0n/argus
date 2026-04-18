import { useState } from 'react';
import type { AgentDTO, SessionDTO, CommandDTO } from '@argus/shared-types';
import { ChevronDown, ChevronRight, Terminal as TerminalIcon } from 'lucide-react';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';
import { StatusDot } from './ui/StatusDot';
import { TerminalPane } from './TerminalPane';
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

      {/* Terminal sits last because it's the only section users actively
          interact with; putting it at the bottom keeps the read-only
          context (agent / session / recent turns) above the fold and
          prevents an expanded xterm from pushing that info off-screen. */}
      <CollapsibleSection
        title="Terminal"
        icon={<TerminalIcon className="h-3 w-3" />}
        // Default-collapsed: spinning up xterm + opening a PTY costs CPU
        // and a network round-trip we shouldn't pay until the user asks.
        defaultOpen={false}
      >
        <TerminalPane key={agent.id} agent={agent} />
      </CollapsibleSection>
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

function CollapsibleSection({
  title,
  icon,
  defaultOpen,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[10px] uppercase tracking-widest text-neutral-600 hover:text-neutral-400"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {icon}
        <span>{title}</span>
      </button>
      {open && <div className="mt-1.5">{children}</div>}
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
