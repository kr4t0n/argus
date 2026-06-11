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

/** Shape persisted in Agent.modelCatalog. */
interface StoredCatalog {
  source: 'static' | 'cli';
  models: ModelCatalogEntry[];
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
 * Server-side half of the model-catalog flow.
 *
 * Reads are DB-first: the sidecar pushes each agent's catalog at
 * supervisor spawn (unsolicited `model-catalog-response` with empty
 * requestId), and every on-demand fetch re-persists — so
 * GET /agents/:id/models is a Postgres read, warm across server
 * restarts and shared by all browsers. The live RPC (same
 * pending-promise pattern as FSService) runs only for: the manual
 * `?refresh=1` path, the cold case (no stored catalog yet), and the
 * background stale-revalidate.
 */
@Injectable()
export class ModelsService implements OnModuleDestroy {
  private readonly logger = new Logger(ModelsService.name);
  private readonly pending = new Map<string, PendingCatalog>();
  /** Collapses concurrent live fetches for the same agent into one RPC. */
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

  async getCatalog(agentId: string, refresh = false): Promise<ModelCatalogResponse> {
    if (refresh) {
      // Manual refresh: the one user-initiated synchronous path —
      // ground truth or a visible error. A failure leaves the stored
      // catalog untouched.
      return this.liveFetch(agentId);
    }

    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, modelCatalog: true, modelCatalogAt: true },
    });
    if (!agent) throw new NotFoundException('agent not found');

    const stored = agent.modelCatalog as StoredCatalog | null;
    if (stored && agent.modelCatalogAt) {
      if (Date.now() - agent.modelCatalogAt.getTime() > REVALIDATE_AFTER_MS) {
        // Stale-while-revalidate: serve immediately, refresh behind.
        this.liveFetch(agentId).catch((err: Error) => {
          this.logger.debug(`background catalog revalidate for ${agentId} failed: ${err.message}`);
        });
      }
      return {
        agentId,
        source: stored.source,
        fetchedAt: agent.modelCatalogAt.toISOString(),
        models: stored.models ?? [],
      };
    }

    // Cold: nothing stored yet (agent predates the push mechanism, or
    // its first push hasn't landed). The picker renders non-blocking
    // regardless; this fetch fills the store for next time too.
    return this.liveFetch(agentId);
  }

  /** Live RPC to the sidecar, collapsed per agent, persisting on success. */
  private liveFetch(agentId: string): Promise<ModelCatalogResponse> {
    const running = this.inflight.get(agentId);
    if (running) return running;

    const fetch = this.fetchCatalog(agentId)
      .then(async (resp) => {
        await this.persist(agentId, { source: resp.source, models: resp.models }, new Date());
        return resp;
      })
      .finally(() => {
        this.inflight.delete(agentId);
      });
    this.inflight.set(agentId, fetch);
    return fetch;
  }

  private async persist(agentId: string, catalog: StoredCatalog, at: Date): Promise<void> {
    try {
      await this.prisma.agent.update({
        where: { id: agentId },
        data: {
          modelCatalog: catalog as unknown as Prisma.InputJsonValue,
          modelCatalogAt: at,
        },
      });
    } catch {
      // Agent deleted between fetch and persist — nothing to store.
    }
  }

  private async fetchCatalog(agentId: string): Promise<ModelCatalogResponse> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, machineId: true },
    });
    if (!agent) throw new NotFoundException('agent not found');

    const requestId = randomUUID();
    const promise = new Promise<ModelCatalogResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BadRequestException('agent did not respond — the machine may be offline'));
      }, LIST_MODELS_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
    });

    try {
      await this.redis.publish(streamKeys.machineControl(agent.machineId), {
        kind: 'list-models',
        requestId,
        agentId,
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
   */
  handleCatalogResponse(ev: ModelCatalogResponseEvent): void {
    if (ev.requestId === '') {
      if (!ev.error && ev.models) {
        void this.persist(
          ev.agentId,
          { source: ev.source ?? 'cli', models: ev.models },
          new Date(ev.ts),
        );
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
      agentId: ev.agentId,
      source: ev.source ?? 'cli',
      fetchedAt: new Date(ev.ts).toISOString(),
      models: ev.models ?? [],
    });
  }
}
