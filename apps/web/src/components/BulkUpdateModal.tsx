import { useEffect, useMemo, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, X } from 'lucide-react';
import type { SidecarVersionInfo } from '@argus/shared-types';
import { useMachineStore } from '../stores/machineStore';
import { useSidecarUpdateStore } from '../stores/sidecarUpdateStore';
import { api, ApiError } from '../lib/api';
import { Button } from './ui/Button';
import { cn } from '../lib/utils';

type RowOutcome =
  | 'will-update'
  | 'skipped-offline'
  | 'skipped-already-current'
  | 'unknown-version';

interface RowPreview {
  machineId: string;
  machineName: string;
  current: string;
  latest: string | null;
  outcome: RowOutcome;
}

/**
 * "Update all sidecars" pre-flight modal.
 *
 * The server's /machines/sidecar/update-all endpoint synchronously
 * returns the plan and asynchronously runs it, so we want to confirm
 * with the operator BEFORE we POST. We compute a best-effort preview
 * client-side from the cached version info (populated by the version
 * badge effect on each MachinePanel mount). The exact server-side
 * plan is reconciled on POST and immediately reflected via the batch
 * progress WS event.
 *
 * Latest-version resolution is delegated to the server: we hit
 * /machines/:id/sidecar/version for any rows whose cache is missing
 * or stale, batched on mount, so the modal can show a confident
 * "from → to" preview rather than greying out every row that hasn't
 * been visited yet.
 */
export function BulkUpdateModal({ onClose }: { onClose: () => void }) {
  const machines = useMachineStore((s) => s.machines);
  const order = useMachineStore((s) => s.order);
  const versions = useSidecarUpdateStore((s) => s.versions);
  const setVersionInfo = useSidecarUpdateStore((s) => s.setVersionInfo);
  const setBatch = useSidecarUpdateStore((s) => s.setBatch);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(true);

  // Eagerly fetch version info for any machines we don't yet have
  // cached. Without this the preview would show every-row "unknown
  // version" until the user had clicked into each MachinePanel.
  useEffect(() => {
    let cancelled = false;
    const missing = order.filter((id) => !versions[id] && machines[id]);
    if (missing.length === 0) {
      setLoadingVersions(false);
      return;
    }
    Promise.allSettled(
      missing.map(async (id) => {
        try {
          const info = await api.getSidecarVersion(id);
          if (!cancelled) setVersionInfo(id, info);
        } catch {
          // Stay quiet: a single 500 shouldn't stop the modal from
          // rendering its preview for the rest of the fleet.
        }
      }),
    ).finally(() => {
      if (!cancelled) setLoadingVersions(false);
    });
    return () => {
      cancelled = true;
    };
  }, [order, machines, versions, setVersionInfo]);

  const rows: RowPreview[] = useMemo(() => {
    return order
      .map<RowPreview | null>((id) => {
        const m = machines[id];
        if (!m || m.archivedAt) return null;
        const v: SidecarVersionInfo | undefined = versions[id];
        const outcome: RowOutcome =
          m.status !== 'online'
            ? 'skipped-offline'
            : !v?.latest
              ? 'unknown-version'
              : v.current === v.latest
                ? 'skipped-already-current'
                : 'will-update';
        return {
          machineId: id,
          machineName: m.name,
          current: m.sidecarVersion,
          latest: v?.latest ?? null,
          outcome,
        };
      })
      .filter((x): x is RowPreview => !!x);
  }, [order, machines, versions]);

  const willUpdate = rows.filter((r) => r.outcome === 'will-update');
  const skipped = rows.filter((r) => r.outcome !== 'will-update');

  async function confirm() {
    if (busy || willUpdate.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const accepted = await api.updateAllSidecars();
      // Seed the batch progress strip; subsequent transitions arrive
      // over WS via App.tsx's onSidecarUpdateBatchProgress handler.
      setBatch({
        batchId: accepted.batchId,
        plan: accepted.plan,
        startedAt: Date.now(),
        dismissed: false,
      });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'failed to start bulk update');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-default bg-surface-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-default px-4 py-3">
          <ArrowUpCircle className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-medium text-fg-primary">
            Update all sidecars
          </h2>
          <button
            onClick={onClose}
            className="ml-auto text-fg-tertiary hover:text-fg-primary"
            title="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="mb-3 text-xs text-fg-tertiary">
            Each online machine running an outdated sidecar will be updated
            sequentially. The runner stops on the first failure so you can
            triage one bad host without re-updating the rest.
          </p>

          {loadingVersions && (
            <div className="rounded-md border border-default bg-surface-1/40 px-3 py-2 text-[11px] text-fg-tertiary">
              Resolving the latest sidecar release for each host…
            </div>
          )}

          {!loadingVersions && rows.length === 0 && (
            <div className="rounded-md border border-default bg-surface-1/40 px-3 py-2 text-[11px] text-fg-tertiary">
              No machines registered.
            </div>
          )}

          {!loadingVersions && rows.length > 0 && (
            <ul className="divide-y divide-default rounded-md border border-default bg-surface-1/30">
              {rows.map((r) => (
                <PreviewRow key={r.machineId} row={r} />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-default px-4 py-3">
          <span className="text-[11px] text-fg-tertiary">
            {willUpdate.length} will update
            {skipped.length > 0 && ` · ${skipped.length} skipped`}
          </span>
          {error && <span className="text-[11px] text-red-400">{error}</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={confirm}
              disabled={busy || loadingVersions || willUpdate.length === 0}
            >
              {busy
                ? 'Starting…'
                : willUpdate.length === 0
                  ? 'Nothing to update'
                  : `Update ${willUpdate.length} sidecar${willUpdate.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewRow({ row }: { row: RowPreview }) {
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-[12px]">
      <span className="truncate text-fg-primary" title={row.machineName}>
        {row.machineName}
      </span>
      <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
        {row.outcome === 'will-update' && (
          <>
            <span className="text-fg-tertiary">{row.current}</span>
            <ArrowUpCircle className="h-3 w-3 text-emerald-400" />
            <span className="text-emerald-400">{row.latest}</span>
          </>
        )}
        {row.outcome === 'skipped-already-current' && (
          <span
            className="inline-flex items-center gap-1 text-fg-tertiary"
            title="already on the latest sidecar"
          >
            <CheckCircle2 className="h-3 w-3" />
            up to date
          </span>
        )}
        {row.outcome === 'skipped-offline' && (
          <span
            className={cn('text-fg-muted')}
            title="machine is offline — the bulk runner will skip it"
          >
            offline
          </span>
        )}
        {row.outcome === 'unknown-version' && (
          <span
            className="text-amber-500"
            title="couldn't reach GitHub — the server will retry when the bulk runs"
          >
            latest unknown
          </span>
        )}
      </span>
    </li>
  );
}
