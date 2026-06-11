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

// Catalogs change when a vendor ships a model — hourly staleness is
// fine, and every dialog-open hitting a CLI exec on the sidecar would
// be rude. `?refresh=1` bypasses for the explicit refresh affordance.
const CATALOG_TTL_MS = 60 * 60 * 1_000;

interface CachedCatalog {
  resp: ModelCatalogResponse;
  expiresAt: number;
}

/**
 * Server-side half of the model-catalog RPC, mirroring FSService:
 * publish `list-models` on the machine control stream, resolve the
 * pending promise when MachineService routes the
 * `model-catalog-response` back. Adds a per-agent TTL cache on top —
 * unlike fs listings, catalogs are near-static and the sidecar-side
 * cost (a CLI exec, possibly a network call) is worth amortizing.
 *
 * Catalog errors (CLI not logged in, parse failure, unsupported
 * adapter) reject the promise like fs errors do — the dashboard
 * degrades that into a free-text model input rather than a dead end.
 */
@Injectable()
export class ModelsService implements OnModuleDestroy {
  private readonly logger = new Logger(ModelsService.name);
  private readonly pending = new Map<string, PendingCatalog>();
  private readonly cache = new Map<string, CachedCatalog>();
  /** Collapses concurrent fetches for the same agent into one RPC. */
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
    if (!refresh) {
      const cached = this.cache.get(agentId);
      if (cached && cached.expiresAt > Date.now()) return cached.resp;
      const running = this.inflight.get(agentId);
      if (running) return running;
    }

    const fetch = this.fetchCatalog(agentId).then(
      (resp) => {
        this.cache.set(agentId, { resp, expiresAt: Date.now() + CATALOG_TTL_MS });
        this.inflight.delete(agentId);
        return resp;
      },
      (err) => {
        this.inflight.delete(agentId);
        throw err;
      },
    );
    this.inflight.set(agentId, fetch);
    return fetch;
  }

  /** Drop an agent's cached catalog (e.g. when the agent is destroyed). */
  invalidate(agentId: string): void {
    this.cache.delete(agentId);
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
   * Called by MachineService when a `model-catalog-response` lands on
   * the lifecycle stream. No-op for stale requestIds (late response
   * after timeout), same as the fs handlers.
   */
  handleCatalogResponse(ev: ModelCatalogResponseEvent): void {
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
