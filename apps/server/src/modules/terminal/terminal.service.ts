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

@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
  ) {}

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
    const t = await this.requireOwned(userId, msg.terminalId);
    if (t.status === 'closed' || t.status === 'error') return;
    await this.redis.publish(streamKeys.terminalIn(t.agentId), {
      kind: 'terminal-input',
      terminalId: t.id,
      data: msg.data,
      ts: Date.now(),
    });
  }

  async resize(userId: string, msg: TerminalResizeMessage): Promise<void> {
    const t = await this.requireOwned(userId, msg.terminalId);
    if (t.status === 'closed' || t.status === 'error') return;
    const cols = clampDimension(msg.cols, 20, 400);
    const rows = clampDimension(msg.rows, 5, 200);
    await this.redis.publish(streamKeys.terminalIn(t.agentId), {
      kind: 'terminal-resize',
      terminalId: t.id,
      cols,
      rows,
      ts: Date.now(),
    });
    await this.prisma.terminal.update({
      where: { id: t.id },
      data: { cols, rows },
    });
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
    return dto;
  }

  /** Mark a terminal as fully open (first output observed). */
  async markOpenIfNeeded(terminalId: string): Promise<void> {
    const t = await this.prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!t || t.status !== 'opening') return;
    const updated = await this.prisma.terminal.update({
      where: { id: terminalId },
      data: { status: 'open' },
    });
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
