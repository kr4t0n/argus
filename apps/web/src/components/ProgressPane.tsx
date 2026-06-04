import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Terminal, X, XCircle } from 'lucide-react';
import type { BackgroundTaskDTO } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { joinProject, leaveProject, subscribeHandler } from '../lib/ws';
import { cn, relativeTime } from '../lib/utils';

/**
 * Live list of background tasks for one project — the
 * `(machineId, workingDir)` pair that every session in the directory
 * shares. Powered by `argus-bg`: any command the agent runs as
 *
 *   argus-bg --label "training" -- python train.py &
 *
 * shows up here in real time with its tqdm-style progress, then stays
 * around briefly after it finishes so the user gets to see the final
 * "done" or "failed" state before the row drops.
 *
 * On mount we GET the current snapshot (so a tab opened mid-run hydrates
 * instantly), then subscribe to the `project:<machineId>:<workingDir>`
 * Socket.IO room. Three event surfaces feed the same in-component
 * map keyed by taskId:
 *
 *   - `background-task:updated` upserts (covers start / progress / end)
 *   - `background-task:removed` drops after the server's retention TTL
 *   - the initial REST snapshot bulk-seeds at mount
 */
export function ProgressPane({
  machineId,
  workingDir,
}: {
  machineId: string;
  workingDir: string;
}) {
  const [tasks, setTasks] = useState<Map<string, BackgroundTaskDTO>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .listBackgroundTasks(machineId, workingDir)
      .then((res) => {
        if (cancelled) return;
        const next = new Map<string, BackgroundTaskDTO>();
        for (const t of res.tasks) next.set(t.taskId, t);
        setTasks(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : 'failed to load tasks');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machineId, workingDir]);

  useEffect(() => {
    joinProject(machineId, workingDir);
    const unsub = subscribeHandler({
      onBackgroundTaskUpdated: (t) => {
        if (t.machineId !== machineId || t.workingDir !== workingDir) return;
        setTasks((prev) => {
          const next = new Map(prev);
          next.set(t.taskId, t);
          return next;
        });
      },
      onBackgroundTaskRemoved: (p) => {
        if (p.machineId !== machineId || p.workingDir !== workingDir) return;
        setTasks((prev) => {
          if (!prev.has(p.taskId)) return prev;
          const next = new Map(prev);
          next.delete(p.taskId);
          return next;
        });
      },
    });
    return () => {
      unsub();
      leaveProject(machineId, workingDir);
    };
  }, [machineId, workingDir]);

  const ordered = useMemo(() => {
    return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }, [tasks]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-fg-tertiary">
        <Loader2 className="h-3 w-3 animate-spin" /> loading…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="inline-flex items-center gap-1.5 py-2 text-xs text-red-500 dark:text-red-400">
        <AlertCircle className="h-3 w-3" />
        {loadError}
      </div>
    );
  }

  if (ordered.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="space-y-3 pb-3">
      {ordered.map((t) => (
        <TaskCard
          key={t.taskId}
          task={t}
          machineId={machineId}
          workingDir={workingDir}
        />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="space-y-2 py-2 text-[11px] leading-5 text-fg-tertiary">
      <div className="text-fg-secondary">No background tasks running.</div>
      <div>
        Wrap a long-running command with{' '}
        <code className="rounded bg-surface-1/60 px-1.5 py-0.5 font-mono text-[11px] text-fg-secondary">
          argus-bg --label "&lt;name&gt;" -- &lt;command&gt;
        </code>{' '}
        in this project's shell. Its tqdm-style progress will surface here in real time, even after
        you background it with{' '}
        <code className="rounded bg-surface-1/60 px-1.5 py-0.5 font-mono text-[11px] text-fg-secondary">
          &amp;
        </code>
        .
      </div>
    </div>
  );
}

function TaskCard({
  task,
  machineId,
  workingDir,
}: {
  task: BackgroundTaskDTO;
  machineId: string;
  workingDir: string;
}) {
  const ended = task.endedAt != null;
  const done = task.status === 'done';
  const failed = task.status === 'failed';

  const percent =
    typeof task.percent === 'number'
      ? Math.max(0, Math.min(100, task.percent))
      : undefined;
  const indeterminate =
    !ended &&
    percent === undefined &&
    (task.total == null || task.total === 0);

  // Dismiss is only exposed on ended cards. If we showed it on a
  // running card, the next progress event would just re-upsert and
  // the card would pop back in — confusing UX. Wait for end.
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const onDismiss = useCallback(async () => {
    setDismissError(null);
    setDismissing(true);
    try {
      await api.dismissBackgroundTask(machineId, workingDir, task.taskId);
      // The card vanishes when the `background-task:removed` socket
      // event arrives — handled by ProgressPane's subscribeHandler.
      // No local state mutation needed here.
    } catch (err) {
      setDismissError(err instanceof ApiError ? err.message : 'failed to dismiss');
      setDismissing(false);
    }
  }, [machineId, workingDir, task.taskId]);

  return (
    <div
      className={cn(
        'rounded-md border border-default/60 bg-surface-1/40 px-3 py-2.5 transition-colors',
        ended && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-2">
        <StatusIcon ended={ended} done={done} failed={failed} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-fg-primary">
            {task.label || task.taskId.slice(0, 8)}
          </div>
          {task.cmd && task.cmd.length > 0 && (
            <div
              title={task.cmd.join(' ')}
              className="truncate font-mono text-[10.5px] leading-4 text-fg-tertiary"
            >
              {task.cmd.join(' ')}
            </div>
          )}
        </div>
        <span
          className="shrink-0 font-mono tabular-nums text-[10.5px] text-fg-muted"
          title={new Date(task.startedAt).toISOString()}
        >
          {relativeTime(new Date(task.startedAt).toISOString())}
        </span>
        {ended && (
          <button
            type="button"
            onClick={onDismiss}
            disabled={dismissing}
            title="Dismiss"
            aria-label="Dismiss task"
            className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-fg-muted transition-colors hover:bg-surface-2/80 hover:text-fg-primary disabled:opacity-40"
          >
            {dismissing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <X className="h-3 w-3" />
            )}
          </button>
        )}
      </div>

      {(percent !== undefined || indeterminate) && (
        <div className="mt-2 space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2/80">
            <div
              className={cn(
                'h-full transition-all duration-200',
                // running + done both use emerald — the icon already
                // distinguishes the two states (Terminal vs ✓), and
                // a non-green running bar reads as "stalled" against
                // the green track in the user's theme.
                failed ? 'bg-red-500 dark:bg-red-400' : 'bg-emerald-500 dark:bg-emerald-400',
                indeterminate && 'animate-pulse w-full',
              )}
              style={
                indeterminate
                  ? undefined
                  : { width: `${percent ?? (ended && done ? 100 : 0)}%` }
              }
            />
          </div>
          <div className="flex items-center justify-between gap-2 font-mono tabular-nums text-[10.5px] text-fg-tertiary">
            <span>
              {task.current ?? 0}
              {task.total ? ` / ${task.total}` : ''}
              {percent !== undefined ? ` · ${percent.toFixed(0)}%` : ''}
            </span>
            <span className="flex items-center gap-2">
              {task.rate ? (
                <span>
                  {task.rate.toFixed(2)}
                  {task.unit ?? ''}
                </span>
              ) : null}
              {!ended && task.etaSeconds ? <span>ETA {formatEta(task.etaSeconds)}</span> : null}
            </span>
          </div>
        </div>
      )}

      {ended && (
        <div className="mt-2 text-[10.5px] text-fg-tertiary">
          {done
            ? `Done in ${formatDuration(task.endedAt! - task.startedAt)}`
            : `Failed${typeof task.exitCode === 'number' ? ` (exit ${task.exitCode})` : ''} after ${formatDuration(task.endedAt! - task.startedAt)}`}
        </div>
      )}
      {dismissError && (
        <div className="mt-1 text-[10.5px] text-red-500 dark:text-red-400">{dismissError}</div>
      )}
    </div>
  );
}

function StatusIcon({
  ended,
  done,
  failed,
}: {
  ended: boolean;
  done: boolean;
  failed: boolean;
}) {
  if (!ended) {
    return <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-tertiary" />;
  }
  if (done) {
    return (
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500 dark:text-emerald-400" />
    );
  }
  if (failed) {
    return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500 dark:text-red-400" />;
  }
  return <Terminal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-tertiary" />;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, '0')}m`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return formatEta(ms / 1000);
}
