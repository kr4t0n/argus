import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Session as PSession } from '@prisma/client';
import type { SessionDTO } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StreamGateway } from '../gateway/stream.gateway';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StreamGateway,
  ) {}

  static toDto(s: PSession): SessionDTO {
    return {
      id: s.id,
      userId: s.userId,
      agentId: s.agentId,
      title: s.title,
      externalId: s.externalId,
      status: s.status as SessionDTO['status'],
      archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  /**
   * List the user's sessions. Archived sessions are hidden by default and
   * only surface when `includeArchived` is true — the sidebar filter flips
   * this per-agent from the UI.
   */
  async list(userId: string, includeArchived = false) {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { updatedAt: 'desc' },
    });
    return sessions.map(SessionService.toDto);
  }

  async get(userId: string, id: string) {
    const s = await this.prisma.session.findFirst({ where: { id, userId } });
    if (!s) throw new NotFoundException('session not found');
    return s;
  }

  async create(userId: string, agentId: string, title?: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new BadRequestException('unknown agent');
    const s = await this.prisma.session.create({
      data: {
        userId,
        agentId,
        title: title?.trim() || 'New session',
        status: 'active',
      },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionCreated(dto);
    return dto;
  }

  async rename(userId: string, id: string, title: string) {
    await this.get(userId, id);
    const s = await this.prisma.session.update({
      where: { id },
      data: { title: title.trim() || 'Untitled' },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionUpdated(dto);
    return dto;
  }

  /** Soft archive: keep the row + chunks, just flag it so the UI can hide it. */
  async archive(userId: string, id: string) {
    const existing = await this.get(userId, id);
    if (existing.archivedAt) return SessionService.toDto(existing);
    const s = await this.prisma.session.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionUpdated(dto);
    return dto;
  }

  async unarchive(userId: string, id: string) {
    const existing = await this.get(userId, id);
    if (!existing.archivedAt) return SessionService.toDto(existing);
    const s = await this.prisma.session.update({
      where: { id },
      data: { archivedAt: null },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionUpdated(dto);
    return dto;
  }

  /** Hard delete: removes the row and cascades to commands/chunks. */
  async remove(userId: string, id: string) {
    await this.get(userId, id);
    await this.prisma.session.delete({ where: { id } });
  }

  async setStatus(id: string, status: SessionDTO['status']) {
    const s = await this.prisma.session.update({
      where: { id },
      data: { status },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionStatus(dto);
    return dto;
  }

  async setExternalId(id: string, externalId: string) {
    const existing = await this.prisma.session.findUnique({
      where: { id },
      select: { externalId: true },
    });
    if (!existing || existing.externalId) return;
    const s = await this.prisma.session.update({
      where: { id },
      data: { externalId },
    });
    this.gateway.emitSessionUpdated(SessionService.toDto(s));
  }

  async bumpUpdatedAt(id: string) {
    const s = await this.prisma.session.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
    this.gateway.emitSessionUpdated(SessionService.toDto(s));
  }

  /**
   * Return the session + its commands + their chunks.
   *
   *   • `afterSeq` filters chunks by seq (reconnect backfill path — fetches
   *     everything new across all commands since the last seen seq).
   *   • `tailCommands` limits the response to the N most recent commands
   *     (and only their chunks) for the initial page-load path. The web UI
   *     uses this to avoid downloading the entire history of long sessions
   *     up front; older turns stream in on scroll-up. `hasMore` signals
   *     whether older commands exist.
   *
   *  These two are independent: reconnect callers pass just `afterSeq`
   *  and leave `tailCommands` undefined (full-width backfill), while the
   *  page loader passes `tailCommands` and leaves `afterSeq` at 0.
   */
  async getWithChunks(
    userId: string,
    id: string,
    afterSeq = 0,
    tailCommands?: number,
  ) {
    const session = await this.get(userId, id);
    let commands;
    let hasMore = false;
    if (tailCommands && tailCommands > 0) {
      // Take N+1 to detect whether older rows exist without a separate
      // count query; drop the overflow row and reverse to ascending.
      const recent = await this.prisma.command.findMany({
        where: { sessionId: id },
        orderBy: { createdAt: 'desc' },
        take: tailCommands + 1,
      });
      hasMore = recent.length > tailCommands;
      commands = recent.slice(0, tailCommands).reverse();
    } else {
      commands = await this.prisma.command.findMany({
        where: { sessionId: id },
        orderBy: { createdAt: 'asc' },
      });
    }
    const commandIds = commands.map((c) => c.id);
    const chunks = commandIds.length
      ? await this.prisma.resultChunk.findMany({
          where: { commandId: { in: commandIds }, seq: { gt: afterSeq } },
          orderBy: [{ commandId: 'asc' }, { seq: 'asc' }],
        })
      : [];
    return { session: SessionService.toDto(session), commands, chunks, hasMore };
  }

  /**
   * Fetch the N commands older than `beforeCommandId` (and their chunks),
   * used by the UI to stream history in as the user scrolls up. Returns
   * commands in ascending createdAt order to match the normal feed.
   */
  async getOlderHistory(
    userId: string,
    id: string,
    beforeCommandId: string,
    limit: number,
  ) {
    await this.get(userId, id); // auth guard

    // Cursor-based pagination on (createdAt desc, id). Prisma's `cursor`
    // needs a unique field — id works — and `skip: 1` excludes the anchor
    // itself so we only return commands strictly older than it.
    const older = await this.prisma.command.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'desc' },
      cursor: { id: beforeCommandId },
      skip: 1,
      take: limit + 1,
    });
    const hasMore = older.length > limit;
    const commands = older.slice(0, limit).reverse();
    const commandIds = commands.map((c) => c.id);
    const chunks = commandIds.length
      ? await this.prisma.resultChunk.findMany({
          where: { commandId: { in: commandIds } },
          orderBy: [{ commandId: 'asc' }, { seq: 'asc' }],
        })
      : [];
    return { commands, chunks, hasMore };
  }
}
