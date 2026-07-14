import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  streamKeys,
  type ModelCatalogEntry,
  type ModelCatalogResponse,
  type ModelCatalogResponseEvent,
} from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

interface PendingCatalog {
  resolve: (resp: ModelCatalogResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

// Generous relative to fs-list's 5s: codex/cursor catalog production
// shells out to the wrapped CLI, and cursor's `models` makes a vendor
// API call. The sidecar bounds the CLI exec at 12s, so 15s here means
// a wedged CLI surfaces as the sidecar's own catalog error, not as an
// indistinguishable "machine may be offline" timeout.
const LIST_MODELS_TIMEOUT_MS = 15_000;

// Stale-while-revalidate threshold. Reads NEVER block on this — a
// stored catalog older than 6h is served as-is while a background
// refresh runs. 6h catches silently-landed vendor changes same-day;
// everything event-shaped (sidecar restart, CLI rollout) is covered by
// the spawn-time push, and "a model launched an hour ago" by the
// picker's manual refresh.
const REVALIDATE_AFTER_MS = 6 * 60 * 60 * 1_000;

/**
 * Server-side half of the model-catalog flow, keyed by
 * (machineId, cliType) since Phase 2 of the agent→runner refactor — a
 * catalog is a property of the installed binary, not the workdir, so
 * per-agent storage duplicated it per project and left the picker cold
 * for a project's first session of a type.
 *
 * Reads are DB-first: the sidecar pushes a catalog at supervisor spawn
 * (unsolicited `model-catalog-response` with empty requestId), and
 * every on-demand fetch re-persists — so reads are Postgres, warm
 * across server restarts and shared by all browsers. The live RPC
 * (same pending-promise pattern as FSService) runs only for: the
 * manual `?refresh=1` path, the cold case, and the background
 * stale-revalidate. The wire request carries `cliType` for Phase-2
 * sidecars plus a representative `agentId` so pre-Phase-2 sidecars
 * keep answering.
 */
@Injectable()
export class ModelsService implements OnModuleDestroy {
  private readonly logger = new Logger(ModelsService.name);
  private readonly pending = new Map<string, PendingCatalog>();
  /** Collapses concurrent live fetches for the same (machine, CLI). */
  private readonly inflight = new Map<string, Promise<ModelCatalogResponse>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleDestroy() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('server shutting down'));
    }
    this.pending.clear();
  }

  /** Legacy agent-addressed read (kept for iOS + old web): resolve the
   *  agent's (machineId, type) and serve the machine-level catalog. */
  async getCatalog(agentId: string, refresh = false): Promise<ModelCatalogResponse> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, machineId: true, type: true },
    });
    if (!agent) throw new NotFoundException('agent not found');
    return this.getCatalogForMachine(agent.machineId, agent.type, refresh);
  }

  async getCatalogForMachine(
    machineId: string,
    cliType: string,
    refresh = false,
  ): Promise<ModelCatalogResponse> {
    if (refresh) {
      // Manual refresh: the one user-initiated synchronous path —
      // ground truth or a visible error. A failure leaves the stored
      // catalog untouched.
      return this.liveFetch(machineId, cliType);
    }

    const stored = await this.prisma.machineCliCatalog.findUnique({
      where: { machineId_cliType: { machineId, cliType } },
    });
    if (stored) {
      if (Date.now() - stored.fetchedAt.getTime() > REVALIDATE_AFTER_MS) {
        // Stale-while-revalidate: serve immediately, refresh behind.
        this.liveFetch(machineId, cliType).catch((err: Error) => {
          this.logger.debug(
            `background catalog revalidate for ${machineId}/${cliType} failed: ${err.message}`,
          );
        });
      }
      return {
        machineId,
        cliType,
        source: (stored.source as 'static' | 'cli') ?? 'cli',
        fetchedAt: stored.fetchedAt.toISOString(),
        models: (stored.models as unknown as ModelCatalogEntry[]) ?? [],
      };
    }

    // Cold: nothing stored yet. The picker renders non-blocking
    // regardless; this fetch fills the store for next time too.
    return this.liveFetch(machineId, cliType);
  }

  /** Live RPC to the sidecar, collapsed per (machine, CLI), persisting
   *  on success. */
  private liveFetch(machineId: string, cliType: string): Promise<ModelCatalogResponse> {
    const key = `${machineId}::${cliType}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const fetch = this.fetchCatalog(machineId, cliType)
      .then(async (resp) => {
        await this.persist(machineId, cliType, resp.source, resp.models, new Date());
        return resp;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, fetch);
    return fetch;
  }

  private async persist(
    machineId: string,
    cliType: string,
    source: string,
    models: ModelCatalogEntry[],
    at: Date,
  ): Promise<void> {
    try {
      await this.prisma.machineCliCatalog.upsert({
        where: { machineId_cliType: { machineId, cliType } },
        create: {
          machineId,
          cliType,
          source,
          models: models as unknown as Prisma.InputJsonValue,
          fetchedAt: at,
        },
        update: {
          source,
          models: models as unknown as Prisma.InputJsonValue,
          fetchedAt: at,
        },
      });
    } catch {
      // Machine deleted between fetch and persist — nothing to store.
    }
  }

  private async fetchCatalog(machineId: string, cliType: string): Promise<ModelCatalogResponse> {
    // Representative agent: pre-Phase-2 sidecars route list-models by
    // agentId only. Any live same-type agent works — the catalog
    // doesn't depend on the workdir. None found is fine for Phase-2
    // sidecars (they answer via cliType); an old sidecar then replies
    // with its "agent not running" error, which is the honest state.
    const rep = await this.prisma.agent.findFirst({
      where: { machineId, type: cliType, archivedAt: null },
      select: { id: true },
      orderBy: { registeredAt: 'asc' },
    });

    const requestId = randomUUID();
    const promise = new Promise<ModelCatalogResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BadRequestException('agent did not respond — the machine may be offline'));
      }, LIST_MODELS_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
    });

    try {
      await this.redis.publish(streamKeys.machineControl(machineId), {
        kind: 'list-models',
        requestId,
        agentId: rep?.id ?? '',
        cliType,
        ts: Date.now(),
      });
    } catch (err) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
      }
      throw err;
    }
    return promise;
  }

  /**
   * Called by MachineService for every `model-catalog-response` on the
   * lifecycle stream. Two flavors:
   *  - requestId === '': unsolicited spawn-time push — persist only.
   *    The sidecar never pushes errors, so models are present.
   *  - otherwise: resolve the pending REST call (no-op for stale ids).
   *    Persistence for this flavor happens in liveFetch so the manual
   *    refresh path can await it.
   * Phase-2 sidecars self-describe with `cliType`; for older ones the
   * type is resolved from the agent row.
   */
  handleCatalogResponse(ev: ModelCatalogResponseEvent): void {
    if (ev.requestId === '') {
      if (!ev.error && ev.models) {
        void this.persistFromEvent(ev);
      }
      return;
    }
    const pending = this.pending.get(ev.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(ev.requestId);
    if (ev.error) {
      pending.reject(new BadRequestException(ev.error));
      return;
    }
    pending.resolve({
      machineId: ev.machineId,
      cliType: ev.cliType ?? '',
      source: ev.source ?? 'cli',
      fetchedAt: new Date(ev.ts).toISOString(),
      models: ev.models ?? [],
    });
  }

  private async persistFromEvent(ev: ModelCatalogResponseEvent): Promise<void> {
    let cliType = ev.cliType;
    if (!cliType && ev.agentId) {
      const agent = await this.prisma.agent
        .findUnique({ where: { id: ev.agentId }, select: { type: true } })
        .catch(() => null);
      cliType = agent?.type;
    }
    if (!cliType) return;
    await this.persist(ev.machineId, cliType, ev.source ?? 'cli', ev.models ?? [], new Date(ev.ts));
  }
}
