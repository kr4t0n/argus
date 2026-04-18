import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Terminal as PTerminal } from '@prisma/client';
import {
  type OpenTerminalRequest,
  type TerminalDTO,
  type TerminalInputMessage,
  type TerminalResizeMessage,
} from '@argus/shared-types';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { SidecarLinkService } from '../sidecar-link/sidecar-link.service';

/**
 * In-memory view of the subset of terminal state needed on the hot path.
 *
 * Hot-path writes (input/resize) arrive once per keystroke; we don't
 * want a Postgres round-trip on each one — that's the whole reason
 * Tier-1 exists. Cache invariants:
 *
 *   - Populated on `open()` and on any cache-missing ownership check.
 *   - `status` is flipped to a terminal state ('closed'/'error') by
 *     `markClosed()` and then the entry is dropped so subsequent use
 *     forces a fresh DB read (defensive).
 *   - `cols`/`rows` intentionally NOT cached; they change via resize()
 *     which can tolerate an eventually-consistent DB write.
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
    private readonly gateway: StreamGateway,
    private readonly link: SidecarLinkService,
  ) {}

  /**
   * Ownership check that prefers the in-memory cache so we don't round
   * trip to Postgres on every keystroke. DB is consulted only on cache
   * miss (first use after boot, or after a terminal was evicted).
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
    if (!agent.supportsTerminal) {
      throw new BadRequestException(
        'agent does not support terminals (sidecar must set terminal.enabled in YAML)',
      );
    }
    if (!this.link.isConnected(agentId)) {
      throw new ServiceUnavailableException(
        'sidecar link not connected (check sidecar logs and server.url in its YAML)',
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

    const sent = this.link.send(agentId, {
      kind: 'terminal-open',
      terminalId: id,
      agentId,
      shell: req.shell ?? '',
      cwd: req.cwd ?? '',
      cols,
      rows,
      ts: Date.now(),
    });
    if (!sent) {
      // Race: link dropped between the isConnected check and the send.
      // Roll back the row so the client gets a clean error and no
      // orphaned "opening" terminal lingers in the DB.
      await this.prisma.terminal
        .delete({ where: { id } })
        .catch(() => undefined);
      throw new ServiceUnavailableException('sidecar link dropped during open');
    }

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
    // Fire-and-forget: even if the link is down we still want to mark
    // the row closed so the UI stops showing a zombie terminal.
    const sent = this.link.send(t.agentId, {
      kind: 'terminal-close',
      terminalId: t.id,
      ts: Date.now(),
    });
    if (!sent) {
      await this.markClosed(terminalId, -1, 'sidecar link not connected');
    }
    return TerminalService.toDto(t);
  }

  async input(userId: string, msg: TerminalInputMessage): Promise<void> {
    const meta = await this.checkOwnedFast(userId, msg.terminalId);
    if (!meta) return;
    const ok = this.link.send(meta.agentId, {
      kind: 'terminal-input',
      terminalId: msg.terminalId,
      data: msg.data,
      ts: Date.now(),
    });
    if (!ok) {
      // Don't throw — input messages are best-effort and the UI will
      // see the terminal flip to closed once our disconnect handler
      // (TerminalLinkBridge) marks it.
      this.logger.debug(`drop input for ${msg.terminalId}: link not connected`);
    }
  }

  async resize(userId: string, msg: TerminalResizeMessage): Promise<void> {
    const meta = await this.checkOwnedFast(userId, msg.terminalId);
    if (!meta) return;
    const cols = clampDimension(msg.cols, 20, 400);
    const rows = clampDimension(msg.rows, 5, 200);
    // Publish first so the pty resizes as soon as possible; persist the
    // dimensions for replay in the background — a dropped write here
    // is cosmetic, not a correctness issue.
    this.link.send(meta.agentId, {
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
   * Called by `TerminalLinkBridge` when the sidecar reports a terminal
   * as closed, OR when the link drops and we need to force-close all
   * of that sidecar's open terminals. Idempotent.
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
    const status = exitCode < 0 ? 'error' : 'closed';
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

  /** Mark all of a sidecar's not-yet-closed terminals as closed with
   *  the given reason. Used by TerminalLinkBridge on disconnect. */
  async markAllForAgentClosed(agentId: string, reason: string): Promise<void> {
    const rows = await this.prisma.terminal.findMany({
      where: { agentId, status: { in: ['opening', 'open'] } },
      select: { id: true },
    });
    await Promise.all(
      rows.map((r) => this.markClosed(r.id, -1, reason).catch(() => undefined)),
    );
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
