import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Agent as PAgent } from '@prisma/client';
import type { AgentDTO, LifecycleEvent } from '@argus/shared-types';
import { consumerGroups, streamKeys } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';

const CONSUMER = 'server-1';
const STALE_AFTER_MS = 30_000;
const SWEEP_INTERVAL_MS = 15_000;

@Injectable()
export class AgentRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRegistryService.name);
  private running = false;
  private sweepTimer?: NodeJS.Timeout;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
  ) {}

  async onModuleInit() {
    await this.redis.ensureGroup(streamKeys.lifecycle, consumerGroups.lifecycle);
    this.running = true;
    this.loopPromise = this.consumeLoop();
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // allow blocking xread to unblock naturally
    await Promise.race([
      this.loopPromise,
      new Promise((r) => setTimeout(r, 6_000)),
    ]);
  }

  listAll(includeArchived = false): Promise<PAgent[]> {
    return this.prisma.agent.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ status: 'asc' }, { type: 'asc' }, { machine: 'asc' }],
    });
  }

  get(id: string) {
    return this.prisma.agent.findUnique({ where: { id } });
  }

  /**
   * Soft-archives an agent: hides it from the default sidebar list but keeps
   * the row (and therefore all its sessions / commands / chunks) intact.
   * If the sidecar later re-registers it stays archived; the user must
   * explicitly unarchive to bring it back into view.
   */
  async archive(id: string): Promise<PAgent> {
    const existing = await this.prisma.agent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('agent not found');
    const saved = await this.prisma.agent.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    this.gateway.emitAgentUpsert(AgentRegistryService.toDto(saved));
    this.logger.log(`archived ${id}`);
    return saved;
  }

  async unarchive(id: string): Promise<PAgent> {
    const existing = await this.prisma.agent.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('agent not found');
    const saved = await this.prisma.agent.update({
      where: { id },
      data: { archivedAt: null },
    });
    this.gateway.emitAgentUpsert(AgentRegistryService.toDto(saved));
    this.logger.log(`unarchived ${id}`);
    return saved;
  }

  static toDto(a: PAgent): AgentDTO {
    return {
      id: a.id,
      type: a.type,
      machine: a.machine,
      status: a.status as AgentDTO['status'],
      capabilities: (a.capabilities as string[]) ?? [],
      version: a.version,
      workingDir: a.workingDir,
      lastHeartbeatAt: a.lastHeartbeatAt.toISOString(),
      registeredAt: a.registeredAt.toISOString(),
      archivedAt: a.archivedAt ? a.archivedAt.toISOString() : null,
    };
  }

  private async consumeLoop() {
    while (this.running) {
      try {
        const res = (await this.redis.read.xreadgroup(
          'GROUP',
          consumerGroups.lifecycle,
          CONSUMER,
          'COUNT',
          50,
          'BLOCK',
          5_000,
          'STREAMS',
          streamKeys.lifecycle,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) continue;
        for (const [, entries] of res) {
          for (const [msgId, fields] of entries) {
            try {
              const data = parseData(fields);
              if (data) await this.handle(data as LifecycleEvent);
            } catch (err) {
              this.logger.error(
                `failed to handle lifecycle event: ${(err as Error).message}`,
              );
            }
            await this.redis.cmd.xack(streamKeys.lifecycle, consumerGroups.lifecycle, msgId);
          }
        }
      } catch (err) {
        if (this.running) {
          this.logger.error(`lifecycle loop error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  private async handle(ev: LifecycleEvent) {
    switch (ev.kind) {
      case 'register': {
        const now = new Date();
        const workingDir = ev.workingDir ?? null;
        const saved = await this.prisma.agent.upsert({
          where: { id: ev.id },
          create: {
            id: ev.id,
            type: ev.type,
            machine: ev.machine,
            status: 'online',
            capabilities: ev.capabilities,
            version: ev.version,
            workingDir,
            lastHeartbeatAt: now,
            registeredAt: now,
          },
          update: {
            type: ev.type,
            machine: ev.machine,
            status: 'online',
            capabilities: ev.capabilities,
            version: ev.version,
            workingDir,
            lastHeartbeatAt: now,
          },
        });
        this.gateway.emitAgentUpsert(AgentRegistryService.toDto(saved));
        this.logger.log(`registered ${ev.id} (${ev.type} @ ${ev.machine})`);
        break;
      }
      case 'heartbeat': {
        const saved = await this.prisma.agent.update({
          where: { id: ev.id },
          data: { status: ev.status, lastHeartbeatAt: new Date() },
        }).catch(() => null);
        if (saved) this.gateway.emitAgentStatus(saved.id, saved.status as AgentDTO['status']);
        break;
      }
      case 'deregister': {
        const saved = await this.prisma.agent.update({
          where: { id: ev.id },
          data: { status: 'offline' },
        }).catch(() => null);
        if (saved) this.gateway.emitAgentStatus(saved.id, 'offline');
        break;
      }
    }
  }

  private async sweepStale() {
    const threshold = new Date(Date.now() - STALE_AFTER_MS);
    const stale = await this.prisma.agent.findMany({
      where: { status: { not: 'offline' }, lastHeartbeatAt: { lt: threshold } },
      select: { id: true },
    });
    if (stale.length === 0) return;
    await this.prisma.agent.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: 'offline' },
    });
    for (const { id } of stale) this.gateway.emitAgentStatus(id, 'offline');
    this.logger.warn(`swept ${stale.length} stale agent(s)`);
  }
}

function parseData(fields: string[]): unknown | null {
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === 'data') {
      try {
        return JSON.parse(fields[i + 1]!);
      } catch {
        return null;
      }
    }
  }
  return null;
}
