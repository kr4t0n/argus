import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Command as PCommand } from '@prisma/client';
import type { Command as WireCommand, CommandDTO } from '@argus/shared-types';
import { streamKeys } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { SessionService } from '../session/session.service';
import { StreamGateway } from '../gateway/stream.gateway';

@Injectable()
export class CommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(forwardRef(() => SessionService))
    private readonly sessions: SessionService,
    private readonly gateway: StreamGateway,
  ) {}

  static toDto(c: PCommand): CommandDTO {
    return {
      id: c.id,
      sessionId: c.sessionId,
      agentId: c.agentId,
      kind: c.kind as CommandDTO['kind'],
      prompt: c.prompt,
      status: c.status as CommandDTO['status'],
      createdAt: c.createdAt.toISOString(),
      completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    };
  }

  async dispatch(
    userId: string,
    sessionId: string,
    prompt: string,
    options?: Record<string, unknown>,
  ): Promise<CommandDTO> {
    const session = await this.sessions.get(userId, sessionId);

    const agent = await this.prisma.agent.findUnique({ where: { id: session.agentId } });
    if (!agent) throw new BadRequestException('agent gone');
    if (agent.status === 'offline') {
      throw new BadRequestException('agent is offline');
    }

    const cmd = await this.prisma.command.create({
      data: {
        sessionId,
        agentId: session.agentId,
        kind: 'execute',
        prompt,
        status: 'pending',
      },
    });

    const wire: WireCommand = {
      id: cmd.id,
      agentId: cmd.agentId,
      sessionId,
      externalId: session.externalId ?? undefined,
      kind: 'execute',
      prompt,
      options,
    };

    await this.redis.publish(streamKeys.command(agent.id), wire);
    const sent = await this.prisma.command.update({
      where: { id: cmd.id },
      data: { status: 'sent' },
    });

    await this.sessions.bumpUpdatedAt(sessionId);

    const dto = CommandService.toDto(sent);
    this.gateway.emitCommandCreated(dto);
    return dto;
  }

  async cancel(userId: string, commandId: string): Promise<CommandDTO> {
    const cmd = await this.prisma.command.findUnique({
      where: { id: commandId },
      include: { session: true },
    });
    if (!cmd) throw new NotFoundException('command not found');
    if (cmd.session.userId !== userId) throw new NotFoundException('command not found');
    if (['completed', 'failed', 'cancelled'].includes(cmd.status)) {
      return CommandService.toDto(cmd);
    }

    const wire: WireCommand = {
      id: cmd.id,
      agentId: cmd.agentId,
      sessionId: cmd.sessionId,
      kind: 'cancel',
    };
    await this.redis.publish(streamKeys.command(cmd.agentId), wire);

    const updated = await this.prisma.command.update({
      where: { id: commandId },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    const dto = CommandService.toDto(updated);
    this.gateway.emitCommandUpdated(dto);
    return dto;
  }
}
