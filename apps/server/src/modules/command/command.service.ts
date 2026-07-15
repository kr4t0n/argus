import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Command as PCommand } from '@prisma/client';
import type { Command as WireCommand, CommandDTO } from '@argus/shared-types';
import { streamKeys } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { SessionService } from '../session/session.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { AttachmentService } from '../attachment/attachment.service';

@Injectable()
export class CommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(forwardRef(() => SessionService))
    private readonly sessions: SessionService,
    private readonly gateway: StreamGateway,
    private readonly attachments: AttachmentService,
  ) {}

  static toDto(c: PCommand): CommandDTO {
    return {
      id: c.id,
      sessionId: c.sessionId,
      kind: c.kind as CommandDTO['kind'],
      prompt: c.prompt,
      status: c.status as CommandDTO['status'],
      options: (c.options as Record<string, unknown> | null) ?? undefined,
      createdAt: c.createdAt.toISOString(),
      completedAt: c.completedAt ? c.completedAt.toISOString() : null,
    };
  }

  async dispatch(
    userId: string,
    sessionId: string,
    prompt: string,
    options?: Record<string, unknown>,
    attachmentIds?: string[],
  ): Promise<CommandDTO> {
    const session = await this.sessions.get(userId, sessionId);

    // Since Phase 4 a turn routes entirely by the session's pinned
    // (project → machine, cliType) — no Agent row. Gate on machine
    // liveness; runner sidecars send no per-agent signal.
    const routing = await this.sessions.resolveRouting(session);
    if (!routing) {
      throw new BadRequestException('session has no runnable project');
    }
    if (routing.machineStatus === 'offline') {
      throw new BadRequestException('machine is offline');
    }

    // Session-default ModelSelection merged under any per-turn options
    // (per-turn wins key-by-key). Neither side is validated against the
    // model catalog — values pass through to the CLI opaquely. The
    // merged result is also snapshotted on the Command row so history
    // can answer "which model ran this turn?".
    const sessionDefaults = session.modelSelection as Record<string, unknown> | null;
    const mergedOptions =
      sessionDefaults || options ? { ...(sessionDefaults ?? {}), ...(options ?? {}) } : undefined;

    const cmd = await this.prisma.command.create({
      data: {
        sessionId,
        kind: 'execute',
        prompt,
        status: 'pending',
        options: mergedOptions ? (mergedOptions as Prisma.InputJsonValue) : undefined,
      },
    });

    // Link any uploaded files to this command and mint the short-lived
    // pull tokens the sidecar uses to fetch them. Validates ownership;
    // throws (rolling the command into a failed dispatch) on a bad id.
    const refs = await this.attachments.linkAndBuildRefs(userId, attachmentIds, cmd.id);

    const wire: WireCommand = {
      id: cmd.id,
      sessionId,
      externalId: session.externalId ?? undefined,
      kind: 'execute',
      prompt,
      options: mergedOptions,
      attachments: refs.length ? refs : undefined,
      // The runner executes in the session's pinned workdir — resume
      // state is cwd-keyed on disk (§4.1), so it rides every turn.
      workingDir: routing.workingDir ?? undefined,
      cliType: routing.cliType,
    };

    await this.redis.publish(
      streamKeys.runnerCommand(routing.machineId, routing.cliType),
      wire,
    );
    const sent = await this.prisma.command.update({
      where: { id: cmd.id },
      data: { status: 'sent' },
    });

    await this.sessions.bumpUpdatedAt(sessionId);

    // Display DTOs (tokenized urls) so the just-sent turn renders its
    // thumbnails immediately, both for the caller and the WS broadcast.
    const attachments = refs.length ? await this.attachments.dtosForCommand(cmd.id) : undefined;
    const dto: CommandDTO = { ...CommandService.toDto(sent), attachments };
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

    // Cancel lands on the same runner stream the execute went out on —
    // re-derive routing from the session (cliType is immutable, and a
    // sidecar update kills in-flight CLIs anyway). A session that no
    // longer routes (project gone) simply has nothing to cancel.
    const routing = await this.sessions.resolveRouting(cmd.session);
    if (routing) {
      const wire: WireCommand = {
        id: cmd.id,
        sessionId: cmd.sessionId,
        kind: 'cancel',
        workingDir: routing.workingDir ?? undefined,
        cliType: routing.cliType,
      };
      await this.redis.publish(
        streamKeys.runnerCommand(routing.machineId, routing.cliType),
        wire,
      );
    }

    const updated = await this.prisma.command.update({
      where: { id: commandId },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    const dto = CommandService.toDto(updated);
    this.gateway.emitCommandUpdated(dto);
    return dto;
  }
}
