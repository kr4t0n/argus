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
  type FSListResponse,
  type FSListResponseEvent,
} from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

interface Pending {
  resolve: (resp: FSListResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const FS_LIST_TIMEOUT_MS = 5_000;

/**
 * FSService is the server-side half of the filesystem browsing RPC.
 *
 * The flow (for one tree expansion):
 *
 *   1. Dashboard hits `GET /agents/:id/fs/list?path=src` → listDir()
 *   2. We look up the agent's machineId, mint a requestId, stash a
 *      promise in `pending`, and publish `fs-list` to the machine
 *      control stream. A 5s timer guards against lost responses /
 *      offline sidecars.
 *   3. Sidecar reads the request, lists the dir (respecting its
 *      workingDir jail + gitignore), and publishes `fs-list-response`
 *      back on the shared lifecycle stream.
 *   4. MachineService's lifecycle consumer spots the response and
 *      forwards it to `handleResponse()`, which resolves the stashed
 *      promise and the controller returns.
 *
 * We deliberately don't try to cache listings here — the right-pane
 * tree is user-driven (one request per expansion click) and the
 * sidecar's fsnotify watcher already keeps the UI in sync live.
 */
@Injectable()
export class FSService implements OnModuleDestroy {
  private readonly logger = new Logger(FSService.name);
  private readonly pending = new Map<string, Pending>();

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

  /**
   * Request one directory listing for `agentId`. Throws NotFound if
   * the agent doesn't exist, BadRequest if its machine is offline and
   * the sidecar doesn't pick up the request within the timeout, or
   * the sidecar-side error (e.g. path escapes workingDir, permission
   * denied) verbatim if the sidecar rejected the request.
   */
  async listDir(agentId: string, path: string, showAll: boolean): Promise<FSListResponse> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, machineId: true, workingDir: true },
    });
    if (!agent) throw new NotFoundException('agent not found');
    if (!agent.workingDir) {
      throw new BadRequestException('agent has no working directory configured');
    }

    const requestId = randomUUID();
    const promise = new Promise<FSListResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new BadRequestException(
            'agent did not respond — the machine may be offline',
          ),
        );
      }, FS_LIST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
    });

    try {
      await this.redis.publish(streamKeys.machineControl(agent.machineId), {
        kind: 'fs-list',
        requestId,
        agentId,
        path: path ?? '',
        showAll: !!showAll,
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
   * Called by MachineService when an `fs-list-response` lands on the
   * lifecycle stream. No-op if the requestId was already timed out /
   * resolved (late response) — simpler than tracking cancellation.
   */
  handleResponse(ev: FSListResponseEvent): void {
    const pending = this.pending.get(ev.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(ev.requestId);
    if (ev.error) {
      pending.reject(new BadRequestException(ev.error));
      return;
    }
    pending.resolve({
      path: ev.path,
      entries: ev.entries ?? [],
      git: ev.git,
    });
  }
}
