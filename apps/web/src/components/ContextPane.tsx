import { useEffect, useMemo, useState } from 'react';
import type { CommandDTO, MachineDTO, ResultChunkDTO, SessionDTO } from '@argus/shared-types';
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
import { basename, useProjectRef } from '../lib/projects';
import { useProjectStore, projectKey } from '../stores/projectStore';
import { useMachineStore } from '../stores/machineStore';
import { useSessionModel } from '../lib/usage';
import { useUIStore } from '../stores/uiStore';

type Props = {
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

export function ContextPane({ session, commands, chunks }: Props) {
  // Project identity drives every pane now that the Agent entity is
  // retired (Phase 4). The session's pinned projectId resolves to a
  // (machineId, workingDir) pair via the hydrated project rows; the
  // machine row supplies reachability + version metadata that used to
  // live on the agent. Null projectRef (panes hidden) only for
  // workdir-less sessions or during the boot race before rows hydrate.
  const projectRef = useProjectRef(session);
  const projectRows = useProjectStore((st) => st.projects);
  const machine = useMachineStore((st) =>
    projectRef ? st.machines[projectRef.machineId] : undefined,
  );
  const projectRow = projectRef
    ? projectRows[projectKey(projectRef.machineId, projectRef.workingDir)]
    : undefined;
  const workingDir = projectRef?.workingDir ?? null;
  const cliType = session?.cliType ?? null;
  // Terminal capability lives on the Project row (the terminal
  // switchover migrated it off terminal-capable agents), so the
  // project route gates without an agent.
  const projectSupportsTerminal = projectRow?.supportsTerminal === true;
  // Notes / Progress / Diff extensions: when on, each adds a tab to the
  // pane. All gate on a workingDir (the project key for Notes/Progress;
  // file diffs only exist when there's a working tree), matching the
  // Commits/Files tabs.
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
    if (!session) return [];
    const t: Array<{ key: TabKey; label: string }> = [];
    if (workingDir) {
      t.push({ key: 'commits', label: 'Commits' });
      t.push({ key: 'files', label: 'Files' });
    }
    t.push({ key: 'terminal', label: 'Terminal' });
    if (notesEnabled && workingDir) {
      t.push({ key: 'note', label: 'Note' });
    }
    if (progressEnabled && workingDir) {
      t.push({ key: 'progress', label: 'Progress' });
    }
    if (diffEnabled && workingDir) {
      t.push({ key: 'diff', label: 'Diff' });
    }
    return t;
  }, [session, workingDir, notesEnabled, progressEnabled, diffEnabled]);

  const [active, setActive] = useState<TabKey>('commits');
  useEffect(() => {
    if (tabs.length > 0 && !tabs.find((t) => t.key === active)) {
      setActive(tabs[0]!.key);
    }
  }, [tabs, active]);

  if (!session) {
    return <div className="h-full px-4 pt-6 text-sm text-fg-tertiary">no session selected</div>;
  }

  // Pane identity line: the project (its user label, else the cwd
  // basename), falling back to the machine or the session title for
  // workdir-less sessions. The status dot + subtitle track the machine.
  const title =
    projectRow?.name || (workingDir ? basename(workingDir) : machine?.name || session.title);

  return (
    <aside className="flex h-full w-full flex-col border-l border-default bg-surface-0">
      <div className="space-y-4 px-4 pt-6">
        <header className="flex items-center gap-2.5">
          {cliType ? (
            <AgentTypeIcon type={cliType} size={20} />
          ) : (
            <Folder className="h-5 w-5 shrink-0 text-fg-tertiary" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold tracking-tight text-fg-primary">
                {title}
              </span>
              <StatusDot status={machine?.status ?? 'offline'} className="shrink-0" />
            </div>
            <div className="truncate text-[11px] text-fg-tertiary">{machine?.name ?? '—'}</div>
          </div>
          {/* Session-default model picker — sets what the NEXT turn will
              use; the `model` line below shows what the last turn ran on. */}
          <SessionModelChip session={session} machineId={projectRef?.machineId} />
        </header>

        {(workingDir || model) && (
          <div className="space-y-1">
            {workingDir && (
              <div
                title={workingDir}
                className="flex items-center gap-1.5 truncate text-[11px] leading-[22px] text-fg-secondary"
              >
                <Folder className="h-3 w-3 shrink-0 text-fg-tertiary" />
                <span className="truncate">{workingDir}</span>
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

        <DetailsSection machine={machine} session={session} />
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
            <GitLogPanel key={projectRef.projectId} project={projectRef} hideHeader />
          )}
          {active === 'files' && projectRef && (
            <FileTree key={projectRef.projectId} project={projectRef} />
          )}
          {active === 'terminal' && (
            <TerminalPane
              key={projectRef?.projectId ?? session.id}
              project={projectRef}
              supported={projectSupportsTerminal}
              machineName={machine?.name ?? ''}
            />
          )}
          {active === 'note' && projectRef && (
            <NotePane
              key={projectRef.projectId}
              machineId={projectRef.machineId}
              workingDir={projectRef.workingDir}
            />
          )}
          {active === 'progress' && projectRef && (
            <ProgressPane
              key={projectRef.projectId}
              machineId={projectRef.machineId}
              workingDir={projectRef.workingDir}
            />
          )}
          {active === 'diff' && (
            <DiffPane commands={commands} chunks={chunks} workingDir={workingDir} />
          )}
        </div>
      </div>
    </aside>
  );
}

function DetailsSection({
  machine,
  session,
}: {
  machine: MachineDTO | undefined;
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
          <KV k="sidecar" v={machine?.sidecarVersion ?? '—'} />
          {machine && (
            <>
              <KV
                k="registered"
                v={<span title={machine.registeredAt}>{relativeTime(machine.registeredAt)} ago</span>}
              />
              <KV
                k="last seen"
                v={<span title={machine.lastSeenAt}>{relativeTime(machine.lastSeenAt)} ago</span>}
              />
            </>
          )}
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
