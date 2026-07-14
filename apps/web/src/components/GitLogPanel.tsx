import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, RefreshCw } from 'lucide-react';
import type { GitCommit, GitStatus } from '@argus/shared-types';
import { api, ApiError } from '../lib/api';
import { joinAgent, leaveAgent, joinProject, leaveProject, subscribeHandler } from '../lib/ws';
import type { ProjectRef } from '../lib/projects';
import { cn } from '../lib/utils';

type Props = {
  project: ProjectRef;
  /** Mixed-fleet shim — see FileTree. Dies with Phase 4. */
  legacyAgentId?: string;
  /** When true, omit the in-component "Recent commits" caps header +
   *  refresh button. Used by ContextPane, which now wraps this panel
   *  in a generic collapsible Section that owns the header itself. */
  hideHeader?: boolean;
};

/**
 * Right-pane "Recent commits" panel. Renders the current branch (or
 * "detached @ <sha>" in amber) plus a scrollable list of recent
 * commits in the agent's workingDir. Auto-refreshes on the
 * sidecar's debounced `git:changed` push so commits / checkouts /
 * resets show up without polling; manual refresh button covers the
 * paranoid case.
 *
 * Self-hides for non-repos (server returns empty + no GitStatus) so
 * the section disappears gracefully when the agent is pointed at a
 * directory without a `.git/`.
 */
export function GitLogPanel({ project, legacyAgentId, hideHeader = false }: Props) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track whether the FIRST fetch finished so we can skip the
  // self-hide check until we actually know the answer.
  const [loadedOnce, setLoadedOnce] = useState(false);

  const fetchLog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.getProjectGitLog(project.projectId);
      setCommits(resp.commits);
      setGit(resp.git ?? null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'failed to load commits';
      setError(msg);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [project.projectId]);

  // Fetch on mount + whenever the project changes.
  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  // Live refresh: sidecar's secondary git watcher debounces ref
  // movement and pushes a single git:changed per commit/checkout/
  // reset/rebase. Same room subscription pattern as FileTree.
  useEffect(() => {
    joinProject(project.machineId, project.workingDir);
    if (legacyAgentId) joinAgent(legacyAgentId);
    const unsub = subscribeHandler({
      onGitChanged: (ev) => {
        const match = ev.workingDir
          ? ev.machineId === project.machineId && ev.workingDir === project.workingDir
          : !!legacyAgentId && ev.agentId === legacyAgentId;
        if (!match) return;
        // Defer to a microtask so multiple events in the same tick
        // (e.g. paired packed-refs + HEAD) collapse into one fetch.
        queueMicrotask(() => fetchLog());
      },
    });
    return () => {
      unsub();
      leaveProject(project.machineId, project.workingDir);
      if (legacyAgentId) leaveAgent(legacyAgentId);
    };
  }, [project.projectId, project.machineId, project.workingDir, legacyAgentId, fetchLog]);

  // Hide the entire section for non-repos. We can only know that
  // after the first fetch (server returns commits=[] + git=undefined
  // for non-repos). Empty git-init'd repos with no commits ALSO
  // return commits=[], but they DO carry a GitStatus — so the panel
  // still renders with an empty body in that case.
  if (loadedOnce && !error && !git && (!commits || commits.length === 0)) {
    return null;
  }

  return (
    <div>
      {!hideHeader ? (
        <div className="mb-2.5 flex items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-caps">
            <GitBranch className="h-3 w-3" />
            <span>Recent commits</span>
            <BranchLabel git={git} />
          </div>
          <button
            type="button"
            title="Refresh"
            aria-label="Refresh"
            onClick={fetchLog}
            disabled={loading}
            className="rounded p-1 text-fg-muted hover:bg-surface-1 hover:text-fg-tertiary disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin text-fg-secondary')} />
          </button>
        </div>
      ) : (
        // Header is owned by the parent Section; show only the branch
        // label + refresh affordance inline above the list.
        <div className="mb-1.5 flex items-center gap-1.5 text-meta">
          <BranchLabel git={git} />
          <button
            type="button"
            title="Refresh"
            aria-label="Refresh"
            onClick={fetchLog}
            disabled={loading}
            className="ml-auto rounded p-1 text-fg-muted hover:bg-surface-1 hover:text-fg-tertiary disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin text-fg-secondary')} />
          </button>
        </div>
      )}
      {/* Fixed height matches FileTree's `h-56` so the two right-pane
          sections read as one rhythm — `max-h-48` collapsed to content
          height during loading and on small chats, leaving a 1-row
          stub above a full-height tree which looked broken. */}
      <div className="h-full min-h-56 overflow-y-auto overflow-x-hidden font-mono text-[11px] leading-[22px] no-scrollbar">
        {error && <div className="px-2 py-1 text-xs text-red-500 dark:text-red-400">{error}</div>}
        {/* Loading-on-first-fetch indicator. Mirrors the FileTree
            section so the right pane reads consistently — the header
            refresh icon also spins, but a body-level placeholder
            keeps the panel from looking empty during the initial
            round trip. Suppressed once we have commits so a manual
            refresh just spins the header icon, not the whole list. */}
        {!error && loading && !commits && (
          <div className="flex items-center gap-1.5 px-2 py-1 text-fg-tertiary">
            <Loader2 className="h-3 w-3 animate-spin" /> loading…
          </div>
        )}
        {!error && !loading && commits && commits.length === 0 && (
          <div className="px-2 py-1 text-xs text-fg-muted">no commits</div>
        )}
        {!error && commits && commits.length > 0 && (
          <ul>
            {commits.map((c) => (
              <CommitRow key={c.sha} commit={c} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function BranchLabel({ git }: { git: GitStatus | null }) {
  if (!git) return null;
  const label = git.detached ? git.head : git.branch;
  if (!label) return null;
  return (
    <span
      className={cn(
        'truncate font-mono text-[10px] normal-case tracking-normal',
        git.detached ? 'text-amber-300' : 'text-fg-tertiary',
      )}
      title={
        git.detached
          ? `detached HEAD @ ${git.head}`
          : git.head
            ? `${git.branch} @ ${git.head}`
            : (git.branch ?? '')
      }
    >
      {label}
    </span>
  );
}

function CommitRow({ commit }: { commit: GitCommit }) {
  const tooltip =
    `${commit.sha}\n` +
    `${commit.authorName} • ${formatAbsolute(commit.authorDate)}\n\n` +
    commit.subject;
  return (
    <li
      className="group flex items-center gap-2 rounded px-1.5 hover:bg-surface-1/60"
      title={tooltip}
    >
      <span className="shrink-0 text-[10px] text-fg-muted">{commit.shortSha}</span>
      <span className="min-w-0 flex-1 truncate text-fg-primary">{commit.subject}</span>
      <span className="shrink-0 text-[10px] text-fg-muted">
        {formatRelative(commit.authorDate)}
      </span>
    </li>
  );
}

// formatRelative is the lightweight "5m ago" / "2d ago" form used in
// the row. We intentionally avoid pulling in date-fns / dayjs — the
// dashboard ships these strings in lots of places and rolling a tiny
// helper here keeps the component self-contained.
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (deltaSec < 60) return `${deltaSec}s`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  const yr = Math.floor(day / 365);
  return `${yr}y`;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
