import { useEffect, useMemo, useState } from 'react';
import type { AgentDTO, CommandDTO, ResultChunkDTO, SessionDTO } from '@argus/shared-types';
import { ChevronDown, Cpu, Folder, Info } from 'lucide-react';
import { AgentTypeIcon } from './ui/AgentTypeIcon';
import { StatusDot } from './ui/StatusDot';
import { FileTree } from './FileTree';
import { GitLogPanel } from './GitLogPanel';
import { SessionModelChip } from './SessionModelChip';
import { NotePane } from './NotePane';
import { ProgressPane } from './ProgressPane';
import { DiffPane } from './DiffPane';
import { TerminalPane } from './TerminalPane';
import { cn, relativeTime } from '../lib/utils';
import { agentProjectRef, resolveProjectRef } from '../lib/projects';
import { useAgentStore } from '../stores/agentStore';
import { useProjectStore, projectKey } from '../stores/projectStore';
import { useSessionModel } from '../lib/usage';
import { useUIStore } from '../stores/uiStore';

type Props = {
  agent: AgentDTO | undefined;
  session: SessionDTO | undefined;
  /** Loaded commands for the active session — the Diff tab reads the most
   *  recent one to scope its file diffs to the last turn. */
  commands: CommandDTO[];
  /** Whole stream of result chunks for the active session. Used here
   *  to derive token usage and (for the Diff tab) the last turn's file
   *  diffs — kept as a raw prop (not pre-aggregated) so the hook can
   *  memoize against the same array reference Zustand hands out, sharing
   *  the recompute path with the header `UsageBadge`. */
  chunks: ResultChunkDTO[];
};

type TabKey = 'commits' | 'files' | 'terminal' | 'note' | 'progress' | 'diff';

export function ContextPane({ agent, session, commands, chunks }: Props) {
  // Project identity for the fs/git panes (Phase 4 prep): the
  // session's pinned projectId when present, else derived from the
  // agent's (machineId, workingDir) pair via the hydrated rows. Null
  // (panes hidden) only for workdir-less agents or during the boot
  // race before the project rows hydrate.
  const agentsById = useAgentStore((st) => st.agents);
  const projectRows = useProjectStore((st) => st.projects);
  const projectRef = useMemo(
    () =>
      resolveProjectRef(session, agentsById, projectRows) ??
      agentProjectRef(agent, projectRows),
    [session, agent, agentsById, projectRows],
  );
  // Terminal capability moved to the Project row with the terminal
  // switchover (the migration inherited it from terminal-capable
  // agents), so the project route can gate without an agent.
  const projectSupportsTerminal = projectRef
    ? projectRows[projectKey(projectRef.machineId, projectRef.workingDir)]?.supportsTerminal === true
    : false;
  // Notes / Progress / Diff extensions: when on, each adds a tab to the
  // pane. All gate on a workingDir (the project key for Notes/Progress;
  // file diffs only exist when the agent has a working tree), matching
  // the Commits/Files tabs.
  const notesEnabled = useUIStore((s) => s.notesExtensionEnabled);
  const progressEnabled = useUIStore((s) => s.progressExtensionEnabled);
  const diffEnabled = useUIStore((s) => s.diffExtensionEnabled);
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
    if (progressEnabled && agent.workingDir) {
      t.push({ key: 'progress', label: 'Progress' });
    }
    if (diffEnabled && agent.workingDir) {
      t.push({ key: 'diff', label: 'Diff' });
    }
    return t;
  }, [agent, notesEnabled, progressEnabled, diffEnabled]);

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
          {/* Session-default model picker. Lives on the agent row (the
              pane's identity line) rather than the chat header — the
              `model` line below shows what the last turn actually ran
              on, while this chip sets what the NEXT turn will use. */}
          {session && <SessionModelChip session={session} agentId={agent.id} />}
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
          {active === 'commits' && projectRef && (
            <GitLogPanel
              key={projectRef.projectId}
              project={projectRef}
              legacyAgentId={agent.id}
              hideHeader
            />
          )}
          {active === 'files' && projectRef && (
            <FileTree key={projectRef.projectId} project={projectRef} legacyAgentId={agent.id} />
          )}
          {active === 'terminal' && (
            <TerminalPane
              key={projectRef?.projectId ?? agent.id}
              project={projectRef}
              agent={agent}
              // Project capability first (the server gates on it for the
              // project route); the agent flag covers workdir-less
              // sessions still on the legacy route.
              supported={projectSupportsTerminal || agent.supportsTerminal}
              machineName={agent.machineName}
            />
          )}
          {active === 'note' && agent.workingDir && (
            <NotePane key={agent.id} machineId={agent.machineId} workingDir={agent.workingDir} />
          )}
          {active === 'progress' && agent.workingDir && (
            <ProgressPane
              key={`${agent.machineId}:${agent.workingDir}`}
              machineId={agent.machineId}
              workingDir={agent.workingDir}
            />
          )}
          {active === 'diff' && (
            <DiffPane commands={commands} chunks={chunks} workingDir={agent.workingDir} />
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
