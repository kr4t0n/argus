import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  streamKeys,
  type FSListResponse,
  type FSListResponseEvent,
  type FSReadResponse,
  type FSReadResponseEvent,
} from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

interface PendingList {
  kind: 'list';
  resolve: (resp: FSListResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingRead {
  kind: 'read';
  resolve: (resp: FSReadResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type Pending = PendingList | PendingRead;

const FS_LIST_TIMEOUT_MS = 5_000;
// File reads are heavier than listings (up to 1 MB across the wire +
// base64 inflation for images), so we give them more headroom. Slow
// disks / network FUSE mounts can easily exceed 5s.
const FS_READ_TIMEOUT_MS = 15_000;

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
      this.pending.set(requestId, { kind: 'list', resolve, reject, timer });
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
   * Read one file's contents for preview. Same RPC pattern as listDir
   * — a longer timeout (FS_READ_TIMEOUT_MS) accounts for slow disks
   * and the larger payloads file reads carry. The sidecar enforces the
   * jail and the size cap; over-cap returns as a PayloadTooLarge here
   * so the dashboard can render a "file too large" placeholder
   * distinctly from a generic error.
   */
  async readFile(agentId: string, path: string): Promise<FSReadResponse> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, machineId: true, workingDir: true },
    });
    if (!agent) throw new NotFoundException('agent not found');
    if (!agent.workingDir) {
      throw new BadRequestException('agent has no working directory configured');
    }
    if (!path || path === '.' || path === '/') {
      throw new BadRequestException('path is required');
    }

    const requestId = randomUUID();
    const promise = new Promise<FSReadResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new BadRequestException(
            'agent did not respond — the machine may be offline',
          ),
        );
      }, FS_READ_TIMEOUT_MS);
      this.pending.set(requestId, { kind: 'read', resolve, reject, timer });
    });

    try {
      await this.redis.publish(streamKeys.machineControl(agent.machineId), {
        kind: 'fs-read',
        requestId,
        agentId,
        path,
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
    if (!pending || pending.kind !== 'list') return;
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

  /**
   * Called by MachineService when an `fs-read-response` lands. Same
   * late-arrival guard as handleResponse(). The sidecar's wire-flat
   * shape is normalized into the discriminated FSReadResponse here, so
   * callers downstream get a tidy union to switch on.
   */
  handleReadResponse(ev: FSReadResponseEvent): void {
    const pending = this.pending.get(ev.requestId);
    if (!pending || pending.kind !== 'read') return;
    clearTimeout(pending.timer);
    this.pending.delete(ev.requestId);
    if (ev.result === 'error') {
      const msg = ev.error || 'read failed';
      // "file is too large" is the one error worth distinguishing on
      // the wire — the dashboard renders a tailored placeholder for it.
      if (/too large/i.test(msg)) {
        pending.reject(new PayloadTooLargeException(msg));
      } else {
        pending.reject(new BadRequestException(msg));
      }
      return;
    }
    if (ev.result === 'text') {
      pending.resolve({
        path: ev.path,
        result: { kind: 'text', content: ev.content ?? '', size: ev.size ?? 0 },
      });
      return;
    }
    if (ev.result === 'image') {
      pending.resolve({
        path: ev.path,
        result: {
          kind: 'image',
          mime: ev.mime ?? 'application/octet-stream',
          base64: ev.base64 ?? '',
          size: ev.size ?? 0,
        },
      });
      return;
    }
    // 'binary' — no preview, just size for the placeholder copy
    pending.resolve({
      path: ev.path,
      result: { kind: 'binary', size: ev.size ?? 0 },
    });
  }
}
