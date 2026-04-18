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

  /** Return the session + its commands, plus the chunks since `afterSeq` (0 = all). */
  async getWithChunks(userId: string, id: string, afterSeq = 0) {
    const session = await this.get(userId, id);
    const commands = await this.prisma.command.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
    });
    const commandIds = commands.map((c) => c.id);
    const chunks = commandIds.length
      ? await this.prisma.resultChunk.findMany({
          where: { commandId: { in: commandIds }, seq: { gt: afterSeq } },
          orderBy: [{ commandId: 'asc' }, { seq: 'asc' }],
        })
      : [];
    return { session: SessionService.toDto(session), commands, chunks };
  }
}
