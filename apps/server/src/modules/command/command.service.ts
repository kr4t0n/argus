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
import { isRunnerSidecar } from '../machine/sidecar-update.service';

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
      agentId: c.agentId,
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

    const agent = await this.prisma.agent.findUnique({
      where: { id: session.agentId },
      include: { machine: { select: { status: true, sidecarVersion: true } } },
    });
    if (!agent) throw new BadRequestException('agent gone');

    // Phase 3 routing (docs/plan-agent-to-runners.md): sessions pinned
    // to a CLI on a runner-style sidecar dispatch to the machine×CLI
    // stream and gate on machine liveness — runner sidecars send no
    // per-agent heartbeats, so agent.status is machine-implied.
    // Anything else (legacy sidecar, or a pre-backfill session without
    // cliType) keeps the per-agent stream + per-agent gate.
    const runnerCli = isRunnerSidecar(agent.machine.sidecarVersion) ? session.cliType : null;
    if (runnerCli) {
      if (agent.machine.status === 'offline') {
        throw new BadRequestException('machine is offline');
      }
    } else if (agent.status === 'offline') {
      throw new BadRequestException('agent is offline');
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
        agentId: session.agentId,
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
      agentId: cmd.agentId,
      sessionId,
      externalId: session.externalId ?? undefined,
      kind: 'execute',
      prompt,
      options: mergedOptions,
      attachments: refs.length ? refs : undefined,
      // Runner sidecars execute in the session's pinned workdir —
      // resume state is cwd-keyed on disk (§4.1), so it must ride
      // every turn. Legacy sidecars ignore both fields.
      ...(runnerCli
        ? {
            workingDir: await this.resolveWorkingDir(session.projectId, agent.workingDir),
            cliType: runnerCli,
          }
        : {}),
    };

    await this.redis.publish(
      runnerCli ? streamKeys.runnerCommand(agent.machineId, runnerCli) : streamKeys.command(agent.id),
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

  /**
   * The session's pinned workdir for the wire Command: the Project row
   * is authoritative (every session pins one since Phase 1), the agent
   * row covers pre-backfill sessions whose projectId is NULL.
   */
  private async resolveWorkingDir(
    projectId: string | null,
    agentWorkingDir: string | null,
  ): Promise<string | undefined> {
    if (projectId) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { workingDir: true },
      });
      if (project?.workingDir) return project.workingDir;
    }
    return agentWorkingDir ?? undefined;
  }

  async cancel(userId: string, commandId: string): Promise<CommandDTO> {
    const cmd = await this.prisma.command.findUnique({
      where: { id: commandId },
      include: {
        session: true,
        agent: {
          select: {
            machineId: true,
            workingDir: true,
            machine: { select: { sidecarVersion: true } },
          },
        },
      },
    });
    if (!cmd) throw new NotFoundException('command not found');
    if (cmd.session.userId !== userId) throw new NotFoundException('command not found');
    if (['completed', 'failed', 'cancelled'].includes(cmd.status)) {
      return CommandService.toDto(cmd);
    }

    // Cancel must land on the same stream the execute went out on —
    // re-derive dispatch's routing decision from the same inputs
    // (session.cliType is immutable and the sidecar style only changes
    // across an update, which kills in-flight CLIs anyway).
    const runnerCli = isRunnerSidecar(cmd.agent.machine.sidecarVersion)
      ? cmd.session.cliType
      : null;
    const wire: WireCommand = {
      id: cmd.id,
      agentId: cmd.agentId,
      sessionId: cmd.sessionId,
      kind: 'cancel',
      ...(runnerCli
        ? {
            workingDir: await this.resolveWorkingDir(cmd.session.projectId, cmd.agent.workingDir),
            cliType: runnerCli,
          }
        : {}),
    };
    await this.redis.publish(
      runnerCli
        ? streamKeys.runnerCommand(cmd.agent.machineId, runnerCli)
        : streamKeys.command(cmd.agentId),
      wire,
    );

    const updated = await this.prisma.command.update({
      where: { id: commandId },
      data: { status: 'cancelled', completedAt: new Date() },
    });
    const dto = CommandService.toDto(updated);
    this.gateway.emitCommandUpdated(dto);
    return dto;
  }
}
