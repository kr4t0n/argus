import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Terminal as PTerminal } from '@prisma/client';
import {
  streamKeys,
  type OpenTerminalRequest,
  type TerminalDTO,
  type TerminalInputMessage,
  type TerminalResizeMessage,
} from '@argus/shared-types';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';

/**
 * In-memory view of the subset of terminal state needed on the hot path.
 * Input/resize events arrive once per keystroke/pointer move; hitting
 * Postgres for each one added 5-25 ms of latency to terminal echo.
 *
 * Cache invariants:
 *   - Populated on `open()` and `get()`.
 *   - `status` flipped to terminal ('closed'/'error') on `markClosed()`.
 *   - Dropped on `markClosed()` after the emit completes so a future
 *     lookup forces a fresh DB read (defensive: cache only lives while
 *     a pty is plausibly alive).
 * We deliberately do NOT cache anything that mutates outside this
 * service (cols/rows are updated elsewhere by `resize()` itself, so the
 * cached copy would stale — we read them from DB only when we need to
 * actually persist; the hot path doesn't care).
 */
interface HotMeta {
  agentId: string;
  userId: string;
  status: string;
}

@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);
  private readonly hotCache = new Map<string, HotMeta>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
  ) {}

  /**
   * Ownership check that prefers the in-memory cache so we don't round
   * trip to Postgres on every keystroke. DB is consulted on cache miss
   * (first use after boot, or after a long-idle terminal was evicted).
   */
  private async checkOwnedFast(
    userId: string,
    terminalId: string,
  ): Promise<HotMeta | null> {
    const cached = this.hotCache.get(terminalId);
    if (cached) {
      if (cached.userId !== userId) throw new ForbiddenException('terminal not yours');
      if (cached.status === 'closed' || cached.status === 'error') return null;
      return cached;
    }
    const t = await this.requireOwned(userId, terminalId);
    const meta: HotMeta = { agentId: t.agentId, userId: t.userId, status: t.status };
    this.hotCache.set(terminalId, meta);
    if (t.status === 'closed' || t.status === 'error') return null;
    return meta;
  }

  static toDto(t: PTerminal): TerminalDTO {
    return {
      id: t.id,
      agentId: t.agentId,
      userId: t.userId,
      status: t.status as TerminalDTO['status'],
      shell: t.shell,
      cwd: t.cwd,
      cols: t.cols,
      rows: t.rows,
      exitCode: t.exitCode,
      closeReason: t.closeReason,
      openedAt: t.openedAt.toISOString(),
      closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    };
  }

  async open(
    userId: string,
    agentId: string,
    req: OpenTerminalRequest,
  ): Promise<TerminalDTO> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('agent not found');
    if (agent.archivedAt) throw new BadRequestException('agent is archived');
    if (agent.status === 'offline') throw new BadRequestException('agent is offline');
    const caps = (agent.capabilities as string[]) ?? [];
    if (!caps.includes('terminal')) {
      throw new BadRequestException(
        'agent has no terminal capability (sidecar must enable terminal in YAML)',
      );
    }

    const cols = clampDimension(req.cols ?? 120, 20, 400);
    const rows = clampDimension(req.rows ?? 32, 5, 200);
    const id = randomUUID();

    const row = await this.prisma.terminal.create({
      data: {
        id,
        agentId,
        userId,
        status: 'opening',
        shell: req.shell ?? '',
        cwd: req.cwd ?? null,
        cols,
        rows,
      },
    });

    await this.redis.publish(streamKeys.terminalIn(agentId), {
      kind: 'terminal-open',
      terminalId: id,
      agentId,
      shell: req.shell ?? '',
      cwd: req.cwd ?? '',
      cols,
      rows,
      ts: Date.now(),
    });

    this.hotCache.set(id, { agentId, userId, status: 'opening' });
    const dto = TerminalService.toDto(row);
    this.gateway.emitTerminalCreated(dto);
    return dto;
  }

  async close(userId: string, terminalId: string): Promise<TerminalDTO> {
    const t = await this.requireOwned(userId, terminalId);
    if (t.status === 'closed' || t.status === 'error') {
      return TerminalService.toDto(t);
    }
    await this.redis.publish(streamKeys.terminalIn(t.agentId), {
      kind: 'terminal-close',
      terminalId: t.id,
      ts: Date.now(),
    });
    // Don't mark closed yet — wait for the sidecar's terminal-closed
    // event so the row reflects the real exit code.
    return TerminalService.toDto(t);
  }

  async input(userId: string, msg: TerminalInputMessage): Promise<void> {
    const meta = await this.checkOwnedFast(userId, msg.terminalId);
    if (!meta) return;
    await this.redis.publish(streamKeys.terminalIn(meta.agentId), {
      kind: 'terminal-input',
      terminalId: msg.terminalId,
      data: msg.data,
      ts: Date.now(),
    });
  }

  async resize(userId: string, msg: TerminalResizeMessage): Promise<void> {
    const meta = await this.checkOwnedFast(userId, msg.terminalId);
    if (!meta) return;
    const cols = clampDimension(msg.cols, 20, 400);
    const rows = clampDimension(msg.rows, 5, 200);
    // Publish first so the pty resizes as soon as possible; persist the
    // dimensions for resume/replay in the background — a dropped write
    // here is cosmetic, not a correctness issue.
    await this.redis.publish(streamKeys.terminalIn(meta.agentId), {
      kind: 'terminal-resize',
      terminalId: msg.terminalId,
      cols,
      rows,
      ts: Date.now(),
    });
    this.prisma.terminal
      .update({ where: { id: msg.terminalId }, data: { cols, rows } })
      .catch((e) => this.logger.warn(`resize persist failed: ${e}`));
  }

  /**
   * Called by the result-ingestor side when the sidecar reports a
   * terminal as closed. Idempotent so we can safely receive it twice
   * (at-least-once delivery via streams).
   */
  async markClosed(
    terminalId: string,
    exitCode: number,
    reason: string | undefined,
  ): Promise<TerminalDTO | null> {
    const existing = await this.prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!existing) return null;
    if (existing.status === 'closed' || existing.status === 'error') {
      return TerminalService.toDto(existing);
    }
    const status = exitCode === 0 ? 'closed' : exitCode > 0 ? 'closed' : 'error';
    const updated = await this.prisma.terminal.update({
      where: { id: terminalId },
      data: {
        status,
        exitCode,
        closeReason: reason ?? null,
        closedAt: new Date(),
      },
    });
    const dto = TerminalService.toDto(updated);
    this.gateway.emitTerminalUpdated(dto);
    this.gateway.emitTerminalClosed({ terminalId, exitCode, reason });
    this.hotCache.delete(terminalId);
    return dto;
  }

  /** Mark a terminal as fully open (first output observed). */
  async markOpenIfNeeded(terminalId: string): Promise<void> {
    const cached = this.hotCache.get(terminalId);
    if (cached && cached.status !== 'opening') return;
    const t = await this.prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!t || t.status !== 'opening') return;
    const updated = await this.prisma.terminal.update({
      where: { id: terminalId },
      data: { status: 'open' },
    });
    if (cached) cached.status = 'open';
    this.gateway.emitTerminalUpdated(TerminalService.toDto(updated));
  }

  listForAgent(userId: string, agentId: string): Promise<PTerminal[]> {
    return this.prisma.terminal.findMany({
      where: { userId, agentId, status: { in: ['opening', 'open'] } },
      orderBy: { openedAt: 'desc' },
    });
  }

  async get(userId: string, terminalId: string): Promise<PTerminal> {
    return this.requireOwned(userId, terminalId);
  }

  private async requireOwned(userId: string, terminalId: string): Promise<PTerminal> {
    const t = await this.prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!t) throw new NotFoundException('terminal not found');
    if (t.userId !== userId) throw new ForbiddenException('terminal not yours');
    return t;
  }
}

function clampDimension(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
