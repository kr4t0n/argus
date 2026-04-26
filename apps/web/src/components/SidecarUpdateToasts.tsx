import { useEffect } from 'react';
import { CheckCircle2, Loader2, RefreshCw, X, AlertTriangle } from 'lucide-react';
import {
  useSidecarUpdateStore,
  type MachineUpdate,
  type UpdatePhase,
} from '../stores/sidecarUpdateStore';
import { cn } from '../lib/utils';

/**
 * Sidecar self-update toast items (BatchToast + per-machine UpdateToasts).
 * Returns a Fragment so the toast host in `App.tsx` can stack these
 * alongside other toast types in one shared bottom-right column instead
 * of every toast type rendering its own overlapping fixed wrapper.
 *
 * Auto-dismiss rules:
 *   - completed (or manual) → dismiss after 6s
 *   - failed → keep until the user closes it (the message is
 *     usually actionable and shouldn't disappear before they read it)
 *
 * The "dismiss all" affordance is exported separately as
 * `SidecarUpdateBatchDismissAll` so the host can render it at the very
 * bottom of the combined stack regardless of what other toast types
 * are above it.
 */
export function SidecarUpdateToasts() {
  const updates = useSidecarUpdateStore((s) => s.updates);
  const batch = useSidecarUpdateStore((s) => s.batch);
  const dismiss = useSidecarUpdateStore((s) => s.dismiss);

  const visible = Object.values(updates)
    .filter((u) => !u.dismissed)
    .sort((a, b) => b.startedAt - a.startedAt);

  useEffect(() => {
    const timers: number[] = [];
    for (const u of visible) {
      if (u.phase === 'completed') {
        timers.push(window.setTimeout(() => dismiss(u.machineId), 6_000));
      }
    }
    return () => timers.forEach(window.clearTimeout);
  }, [visible, dismiss]);

  return (
    <>
      {batch && !batch.dismissed && <BatchToast />}
      {visible.map((u) => (
        <UpdateToast key={u.machineId} update={u} onDismiss={() => dismiss(u.machineId)} />
      ))}
    </>
  );
}

/**
 * "Dismiss all" affordance for an in-flight bulk sidecar update.
 * Lives at the very bottom of the combined toast stack so it doesn't
 * get sandwiched between toast types as new ones are added. Renders
 * nothing when no batch is active.
 */
export function SidecarUpdateBatchDismissAll() {
  const batch = useSidecarUpdateStore((s) => s.batch);
  const dismissBatch = useSidecarUpdateStore((s) => s.dismissBatch);
  if (!batch || batch.dismissed) return null;
  return (
    <button
      onClick={dismissBatch}
      className="pointer-events-auto self-end text-[10px] uppercase tracking-widest text-neutral-600 hover:text-neutral-300"
    >
      dismiss all
    </button>
  );
}

function UpdateToast({ update, onDismiss }: { update: MachineUpdate; onDismiss: () => void }) {
  const { Icon, color } = phaseChrome(update.phase);
  return (
    <div
      className={cn(
        'pointer-events-auto rounded-lg border bg-neutral-950 px-3 py-2.5 shadow-lg shadow-black/40',
        update.phase === 'failed'
          ? 'border-red-500/40'
          : update.phase === 'completed'
            ? 'border-emerald-500/30'
            : 'border-neutral-800',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', color)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-100">
            <span className="truncate">{update.machineName}</span>
            <span className="ml-auto text-[10px] font-normal text-neutral-500">
              {phaseLabel(update.phase, update.restartMode)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-neutral-400">{phaseDetail(update)}</div>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 text-neutral-600 hover:text-neutral-200"
          title="dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function BatchToast() {
  const batch = useSidecarUpdateStore((s) => s.batch)!;
  const total = batch.plan.length;
  const completed = batch.plan.filter((p) => p.status === 'completed').length;
  const failed = batch.plan.filter((p) => p.status === 'failed').length;
  const skipped = batch.plan.filter(
    (p) => p.status === 'skipped-offline' || p.status === 'skipped-already-current',
  ).length;
  const inProgress = batch.plan.find((p) => p.status === 'in-progress');
  const queued = batch.plan.filter((p) => p.status === 'queued').length;
  const allDone = !inProgress && queued === 0;

  return (
    <div className="pointer-events-auto rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2.5 shadow-lg shadow-black/40">
      <div className="flex items-center gap-2">
        {allDone ? (
          failed > 0 ? (
            <AlertTriangle className="h-4 w-4 text-amber-400" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          )
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
        )}
        <div className="text-[12px] font-medium text-neutral-100">Updating fleet</div>
        <div className="ml-auto text-[10px] text-neutral-500">
          {completed}/{total - skipped} done
          {failed > 0 && ` · ${failed} failed`}
          {skipped > 0 && ` · ${skipped} skipped`}
        </div>
      </div>
      {inProgress && (
        <div className="mt-1.5 truncate text-[11px] text-neutral-400">
          {inProgress.machineName} · {inProgress.fromVersion} → latest
        </div>
      )}
      <div className="mt-2 flex h-1 gap-px overflow-hidden rounded-full bg-neutral-900">
        {batch.plan.map((p) => (
          <div
            key={p.machineId}
            className={cn(
              'flex-1',
              p.status === 'completed' && 'bg-emerald-500/70',
              p.status === 'failed' && 'bg-red-500/70',
              p.status === 'in-progress' && 'bg-blue-500/70',
              p.status === 'queued' && 'bg-neutral-700/50',
              (p.status === 'skipped-offline' || p.status === 'skipped-already-current') &&
                'bg-neutral-800',
            )}
            title={`${p.machineName}: ${p.status}${p.error ? ` — ${p.error}` : ''}`}
          />
        ))}
      </div>
    </div>
  );
}

function phaseChrome(phase: UpdatePhase): {
  Icon: typeof CheckCircle2;
  color: string;
} {
  switch (phase) {
    case 'pending':
    case 'started':
    case 'downloaded':
      return {
        Icon: phase === 'downloaded' ? RefreshCw : Loader2,
        color: 'text-blue-400 animate-spin',
      };
    case 'completed':
      return { Icon: CheckCircle2, color: 'text-emerald-400' };
    case 'failed':
      return { Icon: AlertTriangle, color: 'text-red-400' };
  }
}

function phaseLabel(phase: UpdatePhase, restartMode?: 'self' | 'supervisor' | 'manual'): string {
  switch (phase) {
    case 'pending':
      return 'queued';
    case 'started':
      return 'downloading';
    case 'downloaded':
      return restartMode === 'manual' ? 'restart needed' : 'restarting';
    case 'completed':
      return 'updated';
    case 'failed':
      return 'failed';
  }
}

function phaseDetail(u: MachineUpdate): string {
  switch (u.phase) {
    case 'pending':
      return 'waiting for the sidecar to acknowledge…';
    case 'started':
      return `from ${u.fromVersion} — fetching latest release`;
    case 'downloaded':
      if (u.restartMode === 'manual') {
        return `installed ${u.toVersion ?? ''} — restart the sidecar to activate`;
      }
      if (u.restartMode === 'supervisor') {
        return `installed ${u.toVersion ?? ''} — systemd/launchd is restarting`;
      }
      return `installed ${u.toVersion ?? ''} — restarting daemon`;
    case 'completed':
      return `now running ${u.toVersion ?? ''}`;
    case 'failed':
      return u.error ?? 'unknown error';
  }
}
