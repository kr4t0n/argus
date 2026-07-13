import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Agent as PAgent, Session as PSession } from '@prisma/client';
import type {
  AgentDTO,
  AgentType,
  Command as WireCommand,
  ModelSelection,
  SessionDTO,
} from '@argus/shared-types';
import { streamKeys } from '@argus/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { AttachmentService } from '../attachment/attachment.service';
import { MachineService } from '../machine/machine.service';

/** Internal shape of `create` — mirrors CreateSessionRequest minus the
 *  controller-level concerns (title derivation from prompt, dispatch). */
export interface CreateSessionInput {
  agentId?: string;
  machineId?: string;
  workingDir?: string;
  cliType?: string;
  supportsTerminal?: boolean;
  title?: string;
  modelSelection?: ModelSelection;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
    private readonly attachments: AttachmentService,
    private readonly machines: MachineService,
  ) {}

  /** Decorate raw command rows with their linked attachments (one batch
   *  query). Commands with no files are returned untouched so the wire
   *  stays lean. Shared by the initial-load and scroll-up history paths. */
  private async withAttachments<T extends { id: string }>(commands: T[]): Promise<T[]> {
    const byCmd = await this.attachments.dtosByCommand(commands.map((c) => c.id));
    if (byCmd.size === 0) return commands;
    return commands.map((c) => {
      const a = byCmd.get(c.id);
      return a && a.length ? { ...c, attachments: a } : c;
    });
  }

  static toDto(s: PSession): SessionDTO {
    return {
      id: s.id,
      userId: s.userId,
      agentId: s.agentId,
      projectId: s.projectId ?? null,
      cliType: (s.cliType as AgentType | null) ?? null,
      title: s.title,
      externalId: s.externalId,
      status: s.status as SessionDTO['status'],
      unread: s.unread,
      modelSelection: (s.modelSelection as ModelSelection | null) ?? null,
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

  /**
   * Create a session, addressed either at an explicit agent (legacy
   * shape, kept until iOS goes project-first) or at a project —
   * `machineId` + `cliType` + optional `workingDir` — in which case the
   * server reuses a live same-type agent under that (machine, workdir)
   * or auto-vivifies one with a random name. This is the Phase-1 home
   * of the vivify logic that used to live in the web's
   * CreateAgentPopover: the user names the session, never the agent.
   *
   * Both paths pin `projectId` (upserting the Project row for the
   * pair) and `cliType` on the session — the workdir is per-session
   * state because claude-code/cursor keep resume data on disk keyed by
   * the cwd (see docs/plan-agent-to-runners.md §4.1).
   *
   * Returns the vivified agent alongside the session so the creating
   * client can seed its store without waiting for the `agent:upsert`
   * WS event (`null` when an existing agent was reused).
   */
  async create(
    userId: string,
    input: CreateSessionInput,
  ): Promise<{ session: SessionDTO; agent: AgentDTO | null }> {
    let agent: Pick<PAgent, 'id' | 'machineId' | 'type' | 'workingDir'>;
    let vivified: AgentDTO | null = null;

    if (input.agentId) {
      const row = await this.prisma.agent.findUnique({ where: { id: input.agentId } });
      if (!row) throw new BadRequestException('unknown agent');
      agent = row;
    } else if (input.machineId && input.cliType?.trim()) {
      const workingDir = input.workingDir?.trim() || null;
      const reuse = await this.prisma.agent.findFirst({
        where: {
          machineId: input.machineId,
          type: input.cliType,
          workingDir,
          archivedAt: null,
        },
        // Oldest first: stable reuse target no matter how many
        // same-type agents accumulated under the project.
        orderBy: { registeredAt: 'asc' },
      });
      if (reuse) {
        agent = reuse;
      } else {
        // createAgent validates the machine (exists / not deleted /
        // not archived) and the cliType against availableAdapters,
        // publishes the create-agent control command, and emits
        // agent:upsert — exactly what the popover's client-side
        // vivify did.
        vivified = await this.machines.createAgent(input.machineId, {
          name: `${input.cliType}-${randomUUID().slice(0, 6)}`,
          type: input.cliType as AgentType,
          workingDir: workingDir ?? undefined,
          supportsTerminal: input.supportsTerminal ?? false,
        });
        agent = {
          id: vivified.id,
          machineId: input.machineId,
          type: input.cliType,
          workingDir,
        };
      }
    } else {
      throw new BadRequestException('agentId or machineId+cliType is required');
    }

    const projectId = await this.ensureProject(agent.machineId, agent.workingDir);

    const s = await this.prisma.session.create({
      data: {
        userId,
        agentId: agent.id,
        projectId,
        cliType: agent.type,
        title: input.title?.trim() || 'New session',
        // Empty sessions start `'idle'`, not `'active'`. The sidebar's
        // amber dot tracks `status === 'active'`, and a fresh row has
        // no command in flight yet — `result-ingestor` flips status to
        // `'active'` on the first streaming chunk, so the dot lights up
        // exactly when something is actually running. Forks already
        // use the same initial value (see `fork`).
        status: 'idle',
        modelSelection: input.modelSelection
          ? (input.modelSelection as Prisma.InputJsonValue)
          : undefined,
      },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionCreated(dto);
    return { session: dto, agent: vivified };
  }

  /**
   * Resolve the Project row a session should pin to, creating it if
   * this is the first session under the (machineId, workingDir) pair.
   * Null workingDir (workdir-less agents) means the per-machine
   * "no project" bucket — no row, projectId stays NULL.
   */
  private async ensureProject(
    machineId: string,
    workingDir: string | null,
  ): Promise<string | null> {
    const wd = workingDir?.trim();
    if (!wd) return null;
    const row = await this.prisma.project.upsert({
      where: { machineId_workingDir: { machineId, workingDir: wd } },
      create: { machineId, workingDir: wd },
      update: {},
    });
    return row.id;
  }

  /**
   * Replace the session-default model choice. `null` clears back to
   * "CLI default". Applies to subsequent turns only — in-flight
   * commands already carry their merged options.
   */
  async setModelSelection(userId: string, id: string, selection: ModelSelection | null) {
    await this.get(userId, id);
    const s = await this.prisma.session.update({
      where: { id },
      data: {
        modelSelection:
          selection === null ? Prisma.DbNull : (selection as Prisma.InputJsonValue),
      },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionUpdated(dto);
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

  /**
   * Fork a session at a given command. The new session reproduces every
   * command (and its chunks) up to and including `forkAtCommandId` so
   * the dashboard can render the prior history immediately.
   *
   * If the source session has an `externalId` (i.e. there's CLI-side
   * state on the agent's host) we *also* publish a `clone-session`
   * command to the sidecar: per-adapter Cloner implementations copy the
   * on-disk session file, rewrite any embedded session id, and truncate
   * at the chosen turn. The sidecar reports the new id back via a
   * SessionExternalIDEvent which `setExternalId` lands on the new
   * session — so the next prompt resumes the cloned conversation rather
   * than starting fresh. Sources without an externalId (clone happened
   * before any CLI turn ran) simply skip that path.
   */
  async fork(userId: string, sessionId: string, forkAtCommandId: string, title?: string) {
    const src = await this.get(userId, sessionId);
    const anchor = await this.prisma.command.findUnique({
      where: { id: forkAtCommandId },
    });
    if (!anchor || anchor.sessionId !== sessionId) {
      throw new BadRequestException('command does not belong to this session');
    }

    // Take everything up to and including the anchor, ordered the same
    // way the chat view renders it. Tie-breaker on id keeps the order
    // deterministic if two commands share a createdAt millisecond.
    const prefix = await this.prisma.command.findMany({
      where: {
        sessionId,
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lte: anchor.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const chunks = prefix.length
      ? await this.prisma.resultChunk.findMany({
          where: { commandId: { in: prefix.map((c) => c.id) } },
          orderBy: [{ commandId: 'asc' }, { seq: 'asc' }],
        })
      : [];
    const chunksByCommand = new Map<string, typeof chunks>();
    for (const ch of chunks) {
      const arr = chunksByCommand.get(ch.commandId) ?? [];
      arr.push(ch);
      chunksByCommand.set(ch.commandId, arr);
    }

    const forkTitle = title?.trim() || `Fork of ${src.title}`.slice(0, 200);

    const newSession = await this.prisma.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          userId,
          agentId: src.agentId,
          // A fork lives in the same project on the same CLI by
          // construction — the on-disk clone the sidecar performs is
          // only valid under the source's workingDir (cwd-keyed
          // resume state, see docs/plan-agent-to-runners.md §4.1).
          projectId: src.projectId,
          cliType: src.cliType,
          title: forkTitle,
          status: 'idle',
        },
      });
      for (const c of prefix) {
        const newCmd = await tx.command.create({
          data: {
            sessionId: created.id,
            agentId: c.agentId,
            kind: c.kind,
            prompt: c.prompt,
            // Force-completed: the fork has no live runner to drive
            // this command to its real status, and replaying it as
            // pending would leave a phantom spinner.
            status:
              c.status === 'pending' || c.status === 'sent' || c.status === 'running'
                ? 'completed'
                : c.status,
            createdAt: c.createdAt,
            completedAt: c.completedAt ?? c.createdAt,
          },
        });
        const cmdChunks = chunksByCommand.get(c.id) ?? [];
        if (cmdChunks.length === 0) continue;
        await tx.resultChunk.createMany({
          data: cmdChunks.map((ch) => ({
            commandId: newCmd.id,
            seq: ch.seq,
            kind: ch.kind,
            delta: ch.delta,
            content: ch.content,
            meta: ch.meta ?? undefined,
            ts: ch.ts,
          })),
        });
      }
      return created;
    });

    const dto = SessionService.toDto(newSession);
    this.gateway.emitSessionCreated(dto);

    // Best-effort dispatch of the on-disk clone to the sidecar. We do
    // this AFTER the gateway emit so the dashboard can navigate
    // immediately and the externalId fills in once the sidecar reports
    // back; if the agent is offline or doesn't implement Cloner, the
    // session remains a history-only fork (no externalId) and the next
    // prompt starts a fresh CLI conversation.
    if (src.externalId) {
      const wire: WireCommand = {
        id: randomUUID(),
        agentId: src.agentId,
        sessionId: dto.id,
        kind: 'clone-session',
        clone: {
          srcExternalId: src.externalId,
          turnIndex: prefix.length,
        },
      };
      try {
        await this.redis.publish(streamKeys.command(src.agentId), wire);
      } catch (err) {
        // Don't fail the fork if Redis hiccups — the session row is
        // already there. Log via the gateway logger by re-throwing
        // would surface to the caller; instead swallow and let the
        // user retry by sending a prompt (which triggers a fresh CLI
        // run regardless).
        console.warn(`[fork] clone-session publish failed`, err);
      }
    }

    return dto;
  }

  /**
   * Update a session's lifecycle `status`, optionally flipping the
   * `unread` marker in the same write. Terminal transitions pass
   * `unread: true` (a result the user may not have seen); the streaming
   * transition passes `unread: false` (a fresh turn supersedes any prior
   * unread result). Every write bumps `updatedAt` (Prisma `@updatedAt`),
   * which the client relies on to order out-of-order status echoes.
   */
  async setStatus(id: string, status: SessionDTO['status'], opts?: { unread?: boolean }) {
    const s = await this.prisma.session.update({
      where: { id },
      data: { status, ...(opts?.unread !== undefined ? { unread: opts.unread } : {}) },
    });
    const dto = SessionService.toDto(s);
    this.gateway.emitSessionStatus(dto);
    return dto;
  }

  /**
   * Clear the `unread` marker once the user opens a session — this is
   * what drops the sidebar dot (green or red alike), independent of the
   * `status` lifecycle value, which is left untouched. No-op when
   * already seen, so callers can fire-and-forget on every view.
   * Authorization-checked: throws via `get` if the session belongs to
   * another user.
   */
  async markSeen(userId: string, id: string) {
    const existing = await this.get(userId, id);
    if (!existing.unread) return SessionService.toDto(existing);
    const s = await this.prisma.session.update({
      where: { id },
      data: { unread: false },
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
  async getWithChunks(userId: string, id: string, afterSeq = 0, tailCommands?: number) {
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
    return {
      session: SessionService.toDto(session),
      commands: await this.withAttachments(commands),
      chunks,
      hasMore,
    };
  }

  /**
   * Fetch the N commands older than `beforeCommandId` (and their chunks),
   * used by the UI to stream history in as the user scrolls up. Returns
   * commands in ascending createdAt order to match the normal feed.
   */
  async getOlderHistory(userId: string, id: string, beforeCommandId: string, limit: number) {
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
    return { commands: await this.withAttachments(commands), chunks, hasMore };
  }
}
