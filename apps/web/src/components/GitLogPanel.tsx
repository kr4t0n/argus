import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, RefreshCw } from 'lucide-react';
import type { GitCommit, GitStatus } from '@argus/shared-types';
import { api, ApiError } from '../lib/api';
import { joinAgent, leaveAgent, subscribeHandler } from '../lib/ws';
import { cn } from '../lib/utils';

type Props = {
  agentId: string;
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
export function GitLogPanel({ agentId }: Props) {
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
      const resp = await api.getAgentGitLog(agentId);
      setCommits(resp.commits);
      setGit(resp.git ?? null);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'failed to load commits';
      setError(msg);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [agentId]);

  // Fetch on mount + whenever the agent id changes.
  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  // Live refresh: sidecar's secondary git watcher debounces ref
  // movement and pushes a single git:changed per commit/checkout/
  // reset/rebase. Same room subscription pattern as FileTree.
  useEffect(() => {
    joinAgent(agentId);
    const unsub = subscribeHandler({
      onGitChanged: ({ agentId: eventAgent }) => {
        if (eventAgent !== agentId) return;
        // Defer to a microtask so multiple events in the same tick
        // (e.g. paired packed-refs + HEAD) collapse into one fetch.
        queueMicrotask(() => fetchLog());
      },
    });
    return () => {
      unsub();
      leaveAgent(agentId);
    };
  }, [agentId, fetchLog]);

  // Hide the entire section for non-repos. We can only know that
  // after the first fetch (server returns commits=[] + git=undefined
  // for non-repos). Empty git-init'd repos with no commits ALSO
  // return commits=[], but they DO carry a GitStatus — so the panel
  // still renders with an empty body in that case.
  if (loadedOnce && !error && !git && (!commits || commits.length === 0)) {
    return null;
  }

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-widest text-neutral-600">
          <GitBranch className="h-3 w-3" />
          <span>Recent commits</span>
          <BranchLabel git={git} />
        </div>
        <button
          type="button"
          title="Refresh"
          onClick={fetchLog}
          disabled={loading}
          className="text-neutral-600 hover:text-neutral-300 disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin text-neutral-300')} />
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto overflow-x-hidden rounded-md border border-neutral-900 bg-neutral-950/60 px-1 py-1 font-mono text-[11px]">
        {error && <div className="px-2 py-1 text-[11px] text-red-400">{error}</div>}
        {!error && commits && commits.length === 0 && (
          <div className="px-2 py-1 text-[11px] text-neutral-600">no commits</div>
        )}
        {!error && commits && commits.length > 0 && (
          <ul className="space-y-0.5">
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
        git.detached ? 'text-amber-300' : 'text-neutral-400',
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
      className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-neutral-900/60"
      title={tooltip}
    >
      <span className="shrink-0 text-[10px] text-neutral-600">{commit.shortSha}</span>
      <span className="min-w-0 flex-1 truncate text-neutral-200">{commit.subject}</span>
      <span className="shrink-0 text-[10px] text-neutral-600">
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
