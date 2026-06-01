import { useEffect, useMemo, useState } from 'react';
import type { AgentDTO, ResultChunkDTO, SessionDTO } from '@argus/shared-types';
import { ChevronDown, Cpu, Folder, Info } from 'lucide-react';
import { AgentTypeIcon } from './ui/AgentTypeIcon';
import { StatusDot } from './ui/StatusDot';
import { FileTree } from './FileTree';
import { GitLogPanel } from './GitLogPanel';
import { NotePane } from './NotePane';
import { TerminalPane } from './TerminalPane';
import { cn, relativeTime } from '../lib/utils';
import { useSessionModel } from '../lib/usage';
import { useUIStore } from '../stores/uiStore';

type Props = {
  agent: AgentDTO | undefined;
  session: SessionDTO | undefined;
  /** Whole stream of result chunks for the active session. Used here
   *  only to derive token usage — kept as a raw prop (not pre-aggregated)
   *  so the hook can memoize against the same array reference Zustand
   *  hands out, sharing the recompute path with the header `UsageBadge`. */
  chunks: ResultChunkDTO[];
};

type TabKey = 'commits' | 'files' | 'terminal' | 'note';

export function ContextPane({ agent, session, chunks }: Props) {
  // Notes extension: when on, a "Note" tab joins the pane for a
  // per-project scratchpad. It needs a project to attach to — i.e. a
  // workingDir — so the tab only appears when the agent has one (same
  // gate the Commits/Files tabs use).
  const notesEnabled = useUIStore((s) => s.notesExtensionEnabled);
  // Model surfaces in the very first system / init progress chunk a
  // turn emits, so it appears almost immediately on session open.
  // Token usage (input/output/cache) lives in the header badge's
  // hover tooltip — keeping it out of the always-visible right pane
  // since the tooltip is now reliable (Radix, not native `title`).
  const model = useSessionModel(chunks);

  const tabs = useMemo<Array<{ key: TabKey; label: string }>>(() => {
    if (!agent) return [];
    const t: Array<{ key: TabKey; label: string }> = [];
    if (agent.workingDir) {
      t.push({ key: 'commits', label: 'Commits' });
      t.push({ key: 'files', label: 'Files' });
    }
    t.push({ key: 'terminal', label: 'Terminal' });
    if (notesEnabled && agent.workingDir) {
      t.push({ key: 'note', label: 'Note' });
    }
    return t;
  }, [agent, notesEnabled]);

  const [active, setActive] = useState<TabKey>('commits');
  useEffect(() => {
    if (tabs.length > 0 && !tabs.find((t) => t.key === active)) {
      setActive(tabs[0]!.key);
    }
  }, [tabs, active]);

  if (!agent) {
    return <div className="h-full px-4 pt-6 text-sm text-fg-tertiary">no agent selected</div>;
  }

  return (
    <aside className="flex h-full w-full flex-col border-l border-default bg-surface-0">
      <div className="space-y-4 px-4 pt-6">
        <header className="flex items-center gap-2.5">
          <AgentTypeIcon type={agent.type} size={20} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold tracking-tight text-fg-primary">
                {agent.name || agent.id}
              </span>
              <StatusDot status={agent.status} className="shrink-0" />
            </div>
            <div className="truncate text-[11px] text-fg-tertiary">{agent.machineName}</div>
          </div>
        </header>

        {(agent.workingDir || model) && (
          <div className="space-y-1">
            {agent.workingDir && (
              <div
                title={agent.workingDir}
                className="flex items-center gap-1.5 truncate text-[11px] leading-[22px] text-fg-secondary"
              >
                <Folder className="h-3 w-3 shrink-0 text-fg-tertiary" />
                <span className="truncate">{agent.workingDir}</span>
              </div>
            )}
            {model && (
              <div
                title={model}
                className="flex items-center gap-1.5 truncate text-[11px] leading-[22px] text-fg-secondary"
              >
                <Cpu className="h-3 w-3 shrink-0 text-fg-tertiary" />
                <span className="truncate">{model}</span>
              </div>
            )}
          </div>
        )}

        <DetailsSection agent={agent} session={session} />
      </div>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div role="tablist" className="flex items-center gap-4 border-b border-default px-4">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={active === t.key}
              onClick={() => setActive(t.key)}
              className={cn(
                'relative pb-2 pt-1 text-[11px] font-medium transition-colors',
                active === t.key
                  ? 'text-fg-primary after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[1.5px] after:bg-fg-primary'
                  : 'text-fg-tertiary hover:text-fg-secondary',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 no-scrollbar">
          {active === 'commits' && agent.workingDir && (
            <GitLogPanel key={agent.id} agentId={agent.id} hideHeader />
          )}
          {active === 'files' && agent.workingDir && (
            <FileTree key={agent.id} agentId={agent.id} />
          )}
          {active === 'terminal' && <TerminalPane key={agent.id} agent={agent} />}
          {active === 'note' && agent.workingDir && (
            <NotePane key={agent.id} machineId={agent.machineId} workingDir={agent.workingDir} />
          )}
        </div>
      </div>
    </aside>
  );
}

function DetailsSection({
  agent,
  session,
}: {
  agent: AgentDTO;
  session: SessionDTO | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-caps hover:text-fg-primary"
      >
        <Info className="h-3 w-3" />
        <span className="flex-1 text-left">Details</span>
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-fg-muted transition-transform',
            !open && '-rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          <KV k="version" v={agent.version ?? '—'} />
          <KV
            k="registered"
            v={<span title={agent.registeredAt}>{relativeTime(agent.registeredAt)} ago</span>}
          />
          <KV
            k="last seen"
            v={<span title={agent.lastHeartbeatAt}>{relativeTime(agent.lastHeartbeatAt)} ago</span>}
          />
          {session && (
            <>
              <div className="my-1.5 border-t border-default/50" />
              <KV k="title" v={session.title} />
              <KV k="status" v={session.status} />
              {session.externalId && <KV k="external id" v={session.externalId} />}
              <KV
                k="updated"
                v={<span title={session.updatedAt}>{relativeTime(session.updatedAt)} ago</span>}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-[22px]">
      <span className="text-fg-tertiary">{k}</span>
      <span className="max-w-[60%] truncate text-right text-fg-primary">{v}</span>
    </div>
  );
}
