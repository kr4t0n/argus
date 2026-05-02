import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  streamKeys,
  type SidecarUpdateAccepted,
  type SidecarUpdateBatchAccepted,
  type SidecarUpdateDownloadedEvent,
  type SidecarUpdateFailedEvent,
  type SidecarUpdatePlanEntry,
  type SidecarUpdateStartedEvent,
  type SidecarVersionInfo,
} from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';

/**
 * Repo we resolve the "latest" sidecar tag from. Hard-coded rather than
 * configurable: the dashboard exposes this badge to every operator and
 * we don't want a misconfigured environment variable to silently make
 * the entire fleet "out of date" because we're polling the wrong repo.
 * The local CLI `argus-sidecar update --repo` retains the escape hatch
 * for forks.
 */
const SIDECAR_REPO = 'kr4t0n/argus';

/** Tag prefix our release workflow uses. Mirrors updater.go's tagPrefix
 *  — we filter the same way so a sibling component release (e.g. a
 *  future `argus-web-v…`) doesn't confuse the badge. */
const SIDECAR_TAG_PREFIX = 'argus-sidecar-v';

/** How long to trust a successfully-fetched tag before re-checking GH.
 *  30min keeps us comfortably under the 60-req/h unauth rate limit even
 *  with a busy operator team and gives near-real-time feedback for
 *  freshly-cut releases (operators usually click Update within an hour
 *  of cutting a tag). */
const VERSION_CACHE_TTL_MS = 30 * 60_000;

/** Per-update timeout: covers `started` → `downloaded` (or `failed`).
 *  Generous because a slow GH download on a thin upstream can take
 *  ~30s plus the sidecar's restart handshake. We reject the original
 *  REST call if no progress arrives in this window so the dashboard's
 *  toast doesn't spin forever. */
const UPDATE_TIMEOUT_MS = 90_000;

interface PendingUpdate {
  machineId: string;
  fromVersion: string;
  resolveAccepted: (resp: SidecarUpdateAccepted) => void;
  rejectAccepted: (err: Error) => void;
  // Set after we publish the started event; the bulk runner waits on
  // it for sequencing. Resolves when downloaded lands; rejects when
  // failed lands or the timeout fires.
  completion: Promise<{ toVersion: string }>;
  resolveCompletion: (v: { toVersion: string }) => void;
  rejectCompletion: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * SidecarUpdateService orchestrates remote-triggered self-updates.
 *
 *   1. POST /machines/:id/sidecar/update mints a requestId, stashes a
 *      Pending entry, and publishes `update-sidecar` on the machine
 *      control stream. Returns 202 with the requestId so the dashboard
 *      can match toast updates back to the click.
 *   2. The sidecar emits sidecar-update-started, then either
 *      sidecar-update-downloaded (success: it's about to restart) or
 *      sidecar-update-failed (verbatim reason).
 *   3. MachineService forwards both onto handleUpdateEvent here, which
 *      resolves/rejects the pending promise and broadcasts the WS
 *      event with restartMode info.
 *   4. When the freshly-restarted sidecar re-registers with the new
 *      version, observeMachineRegister() fires `completed` over WS so
 *      the dashboard can flip its toast to a checkmark. (The same
 *      register flips the row's sidecarVersion via MachineService.)
 *
 * Bulk update (`updateAll`) iterates online + out-of-date machines
 * sequentially, re-using the per-machine flow. Stops on first failure
 * to avoid cascading a bad release across the fleet.
 */
@Injectable()
export class SidecarUpdateService implements OnModuleDestroy {
  private readonly logger = new Logger(SidecarUpdateService.name);
  private readonly pending = new Map<string, PendingUpdate>();
  // Maps machineId → in-flight requestId so the register-loop knows
  // which `completed` event to fire when the new sidecar re-registers.
  private readonly waitingForRegister = new Map<
    string,
    { requestId: string; fromVersion: string }
  >();
  // Cache of GH `latest` tag. Refreshed on demand by getVersionInfo().
  private latestCache: { tag: string | null; fetchedAt: number } | null = null;
  private latestFetchInFlight: Promise<string | null> | null = null;
  // Single-flight guard so a click + bulk-run targeting the same
  // machine (or two clicks) can't double-publish.
  private readonly machineLocks = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
  ) {}

  onModuleDestroy() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.rejectCompletion(new Error('server shutting down'));
    }
    this.pending.clear();
    this.waitingForRegister.clear();
  }

  // ───────────────────── REST: per-machine ─────────────────────

  /**
   * Kick off a per-machine update. Returns immediately after the
   * sidecar has acknowledged via the `started` event — we wait for
   * that to land so the dashboard can distinguish "machine offline /
   * sidecar wedged" (rejection) from "in flight" (202).
   */
  async updateOne(machineId: string): Promise<SidecarUpdateAccepted> {
    const machine = await this.prisma.machine.findUnique({
      where: { id: machineId },
      select: { id: true, sidecarVersion: true, status: true, archivedAt: true },
    });
    if (!machine) throw new NotFoundException('machine not found');
    if (machine.archivedAt) {
      throw new BadRequestException('machine is archived');
    }
    if (machine.status !== 'online') {
      throw new BadRequestException('machine is offline');
    }
    if (this.machineLocks.has(machineId)) {
      throw new BadRequestException('an update is already in progress for this machine');
    }
    return this.dispatch(machineId, machine.sidecarVersion);
  }

  // ───────────────────── REST: bulk ─────────────────────

  /**
   * Sequentially update every online machine that's out of date.
   * Returns the planned set immediately (entries pre-marked queued /
   * skipped-offline / skipped-already-current). The actual update
   * loop runs in the background and emits `batch-progress` events
   * after every state transition.
   *
   * Stop-on-failure: if one machine fails, the rest keep their
   * `queued` status so an operator can re-run after fixing the bad
   * machine without re-running the ones that already succeeded.
   */
  async updateAll(): Promise<SidecarUpdateBatchAccepted> {
    const latest = await this.getLatestTag();
    if (!latest) {
      throw new BadRequestException(
        'unable to resolve the latest sidecar release — try again in a moment',
      );
    }
    const machines = await this.prisma.machine.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, sidecarVersion: true, status: true },
      orderBy: [{ name: 'asc' }],
    });

    const batchId = randomUUID();
    const plan: SidecarUpdatePlanEntry[] = machines.map((m) => {
      if (m.status !== 'online') {
        return {
          machineId: m.id,
          machineName: m.name,
          fromVersion: m.sidecarVersion,
          status: 'skipped-offline',
        };
      }
      if (latest && compareSemver(m.sidecarVersion, latest) >= 0) {
        return {
          machineId: m.id,
          machineName: m.name,
          fromVersion: m.sidecarVersion,
          status: 'skipped-already-current',
        };
      }
      return {
        machineId: m.id,
        machineName: m.name,
        fromVersion: m.sidecarVersion,
        status: 'queued',
      };
    });

    // Fire-and-forget the runner so the REST call returns the plan
    // immediately. Errors inside runBatch are translated into per-row
    // status changes + WS events; we never throw out of here.
    void this.runBatch(batchId, plan);

    return { batchId, plan };
  }

  private async runBatch(
    batchId: string,
    plan: SidecarUpdatePlanEntry[],
  ): Promise<void> {
    // Snapshot mutable state on a local copy so emitProgress can
    // safely send the latest view after every transition.
    const state = plan.map((p) => ({ ...p }));
    const emit = () =>
      this.gateway.emitSidecarUpdateBatchProgress({
        batchId,
        plan: state.map((s) => ({ ...s })),
      });
    emit();

    for (const row of state) {
      if (row.status !== 'queued') continue;
      row.status = 'in-progress';
      emit();

      try {
        const accepted = await this.dispatch(row.machineId, row.fromVersion);
        // Wait for downloaded / failed to land.
        const pending = this.pending.get(accepted.requestId);
        if (!pending) {
          throw new Error('internal: pending entry vanished');
        }
        const result = await pending.completion;
        row.toVersion = result.toVersion;
        row.status = 'completed';
        emit();
      } catch (err) {
        row.status = 'failed';
        row.error = (err as Error).message;
        emit();
        this.logger.warn(
          `bulk update batch=${batchId} stopped at ${row.machineName} (${row.machineId}): ${row.error}`,
        );
        // Stop-on-failure: leave remaining queued rows alone so the
        // operator can re-run after triage.
        break;
      }
    }
  }

  // ───────────────────── Version info ─────────────────────

  /**
   * Returns the running sidecar version + latest known release for
   * the dashboard's "update available" badge. The latest tag is
   * cached for VERSION_CACHE_TTL_MS so the badge endpoint doesn't
   * hammer GitHub even when 50 dashboards refresh in lockstep.
   */
  async getVersionInfo(machineId: string): Promise<SidecarVersionInfo> {
    const machine = await this.prisma.machine.findUnique({
      where: { id: machineId },
      select: { id: true, sidecarVersion: true },
    });
    if (!machine) throw new NotFoundException('machine not found');

    const latest = await this.getLatestTag();
    return {
      current: machine.sidecarVersion,
      latest,
      latestCheckedAt: this.latestCache
        ? new Date(this.latestCache.fetchedAt).toISOString()
        : null,
      updateAvailable:
        !!latest &&
        !!machine.sidecarVersion &&
        compareSemver(machine.sidecarVersion, latest) < 0,
    };
  }

  /**
   * Returns the latest sidecar tag, using the in-process cache when
   * still fresh. Coalesces concurrent fetches so a thundering herd of
   * dashboard refreshes hits GH at most once. Returns null on transient
   * GH failure (we'd rather show "unknown" than 500 the badge endpoint).
   */
  private async getLatestTag(): Promise<string | null> {
    const now = Date.now();
    if (
      this.latestCache &&
      now - this.latestCache.fetchedAt < VERSION_CACHE_TTL_MS
    ) {
      return this.latestCache.tag;
    }
    if (this.latestFetchInFlight) {
      return this.latestFetchInFlight;
    }
    this.latestFetchInFlight = this.fetchLatestTag()
      .then((tag) => {
        this.latestCache = { tag, fetchedAt: Date.now() };
        return tag;
      })
      .catch((err) => {
        this.logger.warn(`gh latest tag fetch failed: ${(err as Error).message}`);
        // On failure leave the existing cache (if any) in place so
        // we keep returning the last-known-good tag rather than
        // suddenly flipping every badge to "unknown".
        return this.latestCache?.tag ?? null;
      })
      .finally(() => {
        this.latestFetchInFlight = null;
      });
    return this.latestFetchInFlight;
  }

  private async fetchLatestTag(): Promise<string | null> {
    const url = `https://api.github.com/repos/${SIDECAR_REPO}/releases?per_page=30`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`gh ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const releases = (await res.json()) as Array<{
      tag_name: string;
      draft: boolean;
      prerelease: boolean;
    }>;
    for (const r of releases) {
      if (r.draft || r.prerelease) continue;
      if (!r.tag_name?.startsWith(SIDECAR_TAG_PREFIX)) continue;
      // Strip the `argus-sidecar-v` prefix so the returned value
      // matches the bare semver string the sidecar reports at
      // register time (`Machine.sidecarVersion`). Without this strip,
      // every comparison sees mismatched shapes ("argus-sidecar-v0.1.10"
      // vs "0.1.10") and `updateAvailable` always flips on. Belt-and-
      // braces on prerelease too: a tag with a `-rc.N` suffix is
      // treated as older than the matching stable by compareSemver,
      // so even if the GitHub release wasn't flagged prerelease the
      // comparison won't propose a "newer" RC over a stable.
      return r.tag_name.slice(SIDECAR_TAG_PREFIX.length);
    }
    return null;
  }

  // ───────────────────── Lifecycle ingest hooks ─────────────────────

  /**
   * Called by MachineService when a `sidecar-update-started` /
   * `sidecar-update-downloaded` / `sidecar-update-failed` event lands
   * on the lifecycle stream.
   */
  handleUpdateEvent(
    ev:
      | SidecarUpdateStartedEvent
      | SidecarUpdateDownloadedEvent
      | SidecarUpdateFailedEvent,
  ): void {
    const pending = this.pending.get(ev.requestId);

    switch (ev.kind) {
      case 'sidecar-update-started': {
        this.gateway.emitSidecarUpdateStarted({
          machineId: ev.machineId,
          requestId: ev.requestId,
          fromVersion: ev.fromVersion,
        });
        if (pending) {
          // Resolve the 202 acceptance here so the REST caller knows
          // the sidecar actually picked the request up.
          pending.resolveAccepted({
            requestId: ev.requestId,
            machineId: ev.machineId,
            fromVersion: ev.fromVersion,
          });
        }
        break;
      }
      case 'sidecar-update-downloaded': {
        this.gateway.emitSidecarUpdateDownloaded({
          machineId: ev.machineId,
          requestId: ev.requestId,
          fromVersion: ev.fromVersion,
          toVersion: ev.toVersion,
          restartMode: ev.restartMode as 'self' | 'supervisor' | 'manual',
        });
        if (pending) {
          // Park until the new sidecar re-registers; that's our
          // signal to fire `completed`. The bulk runner waits on
          // pending.completion so it sequences correctly.
          this.waitingForRegister.set(ev.machineId, {
            requestId: ev.requestId,
            fromVersion: ev.fromVersion,
          });
          if (ev.restartMode === 'manual') {
            // Manual restart: the new register may never come (or
            // come hours later). Resolve the completion now with
            // the freshly downloaded tag so the bulk loop doesn't
            // hang. The dashboard already differentiates the toast
            // copy off `restartMode`.
            pending.resolveCompletion({ toVersion: ev.toVersion });
            this.cleanupPending(ev.requestId);
            this.waitingForRegister.delete(ev.machineId);
          }
        }
        break;
      }
      case 'sidecar-update-failed': {
        this.gateway.emitSidecarUpdateFailed({
          machineId: ev.machineId,
          requestId: ev.requestId,
          fromVersion: ev.fromVersion,
          reason: ev.reason,
        });
        if (pending) {
          pending.rejectCompletion(new Error(ev.reason));
          // If we were still waiting on the started event (race:
          // sidecar emits `failed` before `started`, e.g. updater
          // bails immediately), reject the acceptance too.
          pending.rejectAccepted(new Error(ev.reason));
          this.cleanupPending(ev.requestId);
        }
        break;
      }
    }
  }

  /**
   * Called by MachineService whenever a machine-register lands. If we
   * have a pending update for that machine and the new version differs
   * from the one we recorded at dispatch time, emit `completed` and
   * resolve the bulk-loop promise.
   */
  observeMachineRegister(machineId: string, newVersion: string): void {
    const waiting = this.waitingForRegister.get(machineId);
    if (!waiting) return;
    // Only treat this as "new sidecar restarted" if the version
    // actually changed. A stale duplicate register from the same
    // image (e.g. caused by a transient bus hiccup forcing a re-dial)
    // would otherwise prematurely resolve the toast.
    if (newVersion === waiting.fromVersion) return;

    this.waitingForRegister.delete(machineId);
    this.gateway.emitSidecarUpdateCompleted({
      machineId,
      requestId: waiting.requestId,
      fromVersion: waiting.fromVersion,
      toVersion: newVersion,
    });
    const pending = this.pending.get(waiting.requestId);
    if (pending) {
      pending.resolveCompletion({ toVersion: newVersion });
      this.cleanupPending(waiting.requestId);
    }
  }

  // ───────────────────── Internal ─────────────────────

  private async dispatch(
    machineId: string,
    fromVersion: string,
  ): Promise<SidecarUpdateAccepted> {
    this.machineLocks.add(machineId);

    const requestId = randomUUID();
    let resolveAccepted!: (resp: SidecarUpdateAccepted) => void;
    let rejectAccepted!: (err: Error) => void;
    const accepted = new Promise<SidecarUpdateAccepted>((res, rej) => {
      resolveAccepted = res;
      rejectAccepted = rej;
    });
    let resolveCompletion!: (v: { toVersion: string }) => void;
    let rejectCompletion!: (err: Error) => void;
    const completion = new Promise<{ toVersion: string }>((res, rej) => {
      resolveCompletion = res;
      rejectCompletion = rej;
    });

    const timer = setTimeout(() => {
      const reason = `sidecar update timed out after ${Math.round(UPDATE_TIMEOUT_MS / 1000)}s`;
      this.logger.warn(
        `update ${requestId} (machine=${machineId}, from=${fromVersion}) ${reason}`,
      );
      rejectAccepted(new BadRequestException(reason));
      rejectCompletion(new Error(reason));
      this.cleanupPending(requestId);
      // Tell the dashboard so the toast doesn't spin forever.
      this.gateway.emitSidecarUpdateFailed({
        machineId,
        requestId,
        fromVersion,
        reason,
      });
    }, UPDATE_TIMEOUT_MS);

    this.pending.set(requestId, {
      machineId,
      fromVersion,
      resolveAccepted,
      rejectAccepted,
      completion,
      resolveCompletion,
      rejectCompletion,
      timer,
    });

    // The single-update REST path (`updateOne` → `dispatch`) only
    // awaits `accepted`; nothing attaches a handler to `completion`.
    // Without this swallow, the timeout / sidecar-update-failed /
    // onModuleDestroy paths all call `rejectCompletion(...)` on a
    // promise with zero handlers, which Node treats as an unhandled
    // rejection and crashes the process.
    //
    // Adding `.catch()` here marks the original promise as handled
    // for Node's tracker; it does NOT consume the rejection — the
    // bulk runner's `await pending.completion` still receives it
    // through its own try/catch chain. Semantics for both paths are
    // unchanged; only the crash is gone.
    completion.catch(() => undefined);

    try {
      await this.redis.publish(streamKeys.machineControl(machineId), {
        kind: 'update-sidecar',
        requestId,
        ts: Date.now(),
      });
    } catch (err) {
      this.cleanupPending(requestId);
      throw err;
    }

    return accepted;
  }

  private cleanupPending(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    this.machineLocks.delete(p.machineId);
  }
}

/**
 * Compare two semver strings of the shape `MAJOR.MINOR.PATCH[-pre]`.
 * Returns a negative number if `a < b`, zero if equal, positive if
 * `a > b`. Pre-release identifiers (`-rc.1`, `-beta`, `-alpha.2`) are
 * treated as STRICTLY older than the matching stable, matching the
 * semver §11 rule — `0.1.10-rc.1 < 0.1.10`. Within prereleases, dot-
 * separated parts compare numerically when both sides are numeric and
 * lexically otherwise, also per §11.
 *
 * Intentionally a hand-rolled mini-compare instead of pulling in the
 * `semver` package: we only need the two shapes our release pipeline
 * produces (X.Y.Z and X.Y.Z-rc.N) and any extra dependency surface
 * isn't worth shaving lines here.
 */
export function compareSemver(a: string, b: string): number {
  const [aBase, aPre = ''] = a.split('-', 2);
  const [bBase, bPre = ''] = b.split('-', 2);

  const aParts = aBase.split('.').map((p) => parseInt(p, 10) || 0);
  const bParts = bBase.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // Bases match. A bare version outranks any prerelease of the same base.
  if (aPre === '' && bPre === '') return 0;
  if (aPre === '') return 1;
  if (bPre === '') return -1;

  const aPreParts = aPre.split('.');
  const bPreParts = bPre.split('.');
  for (let i = 0; i < Math.max(aPreParts.length, bPreParts.length); i++) {
    const ap = aPreParts[i];
    const bp = bPreParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const aNum = /^\d+$/.test(ap) ? parseInt(ap, 10) : null;
    const bNum = /^\d+$/.test(bp) ? parseInt(bp, 10) : null;
    if (aNum !== null && bNum !== null) {
      const diff = aNum - bNum;
      if (diff !== 0) return diff;
    } else if (aNum !== null) {
      return -1;
    } else if (bNum !== null) {
      return 1;
    } else if (ap !== bp) {
      return ap < bp ? -1 : 1;
    }
  }
  return 0;
}
