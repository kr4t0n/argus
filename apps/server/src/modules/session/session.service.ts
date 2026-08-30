import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Session as PSession } from '@prisma/client';
import type {
  AgentType,
  AvailableAdapter,
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
import { PushService } from '../push/push.service';
import { MachineService } from '../machine/machine.service';

/**
 * Command statuses that mean "this turn is over".
 *
 * Exported because the result ingestor has to agree with this list in TWO
 * places that pull in opposite directions: the finalize branch refuses to
 * re-finalize a command already in one of these states, and the live
 * branch must refuse to mark a session active for one. They were written
 * independently and only the first was guarded, which is exactly how a
 * late chunk could un-finalize a session.
 */
export const TERMINAL_COMMAND_STATUSES = ['completed', 'failed', 'cancelled'] as const;

/** Internal shape of `create` — a project-first session (machineId +
 *  cliType + optional workingDir). `agentId` is gone since Phase 4. */
export interface CreateSessionInput {
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
    private readonly push: PushService,
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
   * Create a session on a project: the request carries `machineId` +
   * `cliType` + optional `workingDir`, and the server upserts the
   * Project row for the (machine, workdir) pair and pins `projectId` +
   * `cliType` on the session (the workdir is per-session state because
   * claude-code/cursor keep resume data on disk keyed by the cwd — see
   * docs/plan-agent-to-runners.md §4.1). The user names the session; no
   * Agent row is created or referenced — the Agent entity was fully
   * retired in the Phase-6 sweep. Routes to the machine's runner for
   * that CLI.
   */
  async create(userId: string, input: CreateSessionInput): Promise<SessionDTO> {
    const machineId = input.machineId?.trim();
    const cliType = input.cliType?.trim();
    if (!machineId || !cliType) {
      throw new BadRequestException('machineId and cliType are required');
    }

    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine || machine.deletedAt) throw new NotFoundException('machine not found');
    if (machine.archivedAt) throw new BadRequestException('machine is archived');
    const adapters = (machine.availableAdapters ?? []) as unknown as AvailableAdapter[];
    if (
      Array.isArray(adapters) &&
      adapters.length > 0 &&
      !adapters.some((a) => a.type === cliType)
    ) {
      throw new BadRequestException(
        `adapter type "${cliType}" is not installed on machine "${machine.name}". ` +
          `Installed: ${adapters.map((a) => a.type).join(', ') || '(none)'}`,
      );
    }

    const workingDir = input.workingDir?.trim() || null;
    const projectId = await this.ensureProject(machineId, workingDir, input.supportsTerminal);

    const s = await this.prisma.session.create({
      data: {
        userId,
        projectId,
        cliType,
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
    return dto;
  }

  /**
   * Resolve the Project row a session should pin to, creating it if
   * this is the first session under the (machineId, workingDir) pair.
   * Null workingDir means the per-machine "no project" bucket — no row,
   * projectId stays NULL. `supportsTerminal` seeds a freshly-created
   * row (an existing row keeps its own value).
   */
  private async ensureProject(
    machineId: string,
    workingDir: string | null,
    supportsTerminal?: boolean,
  ): Promise<string | null> {
    const wd = workingDir?.trim();
    if (!wd) return null;
    const row = await this.prisma.project.upsert({
      where: { machineId_workingDir: { machineId, workingDir: wd } },
      create: { machineId, workingDir: wd, supportsTerminal: supportsTerminal ?? false },
      update: {},
    });
    // The sidecar's fs/git allowlist is a registration-time snapshot, so
    // a project vivified here stays unknown to it — the Files/Commits
    // panels fail with "workingDir is not a known project" — until the
    // sidecar's next restart. Re-push the snapshot: idempotent, one
    // control entry. Never fail session creation over a control-stream
    // hiccup (the register-time re-sync heals).
    try {
      await this.machines.syncProjects(machineId);
    } catch {
      /* register-time sync heals */
    }
    return row.id;
  }

  /**
   * Resolve where a session's turns run: (machine, workingDir, cliType)
   * plus the machine's current status for the dispatch gate. `projectId`
   * is authoritative; the agent row is a fallback only for old
   * workdir-less sessions created before Phase 1 whose projectId is
   * NULL but whose agent row still exists. Returns null when the session
   * can't be routed (no cliType, or neither anchor resolves).
   */
  async resolveRouting(
    session: Pick<PSession, 'projectId' | 'cliType'>,
  ): Promise<{
    machineId: string;
    workingDir: string | null;
    cliType: string;
    machineStatus: string;
  } | null> {
    const cliType = session.cliType;
    if (!cliType) return null;
    if (session.projectId) {
      const p = await this.prisma.project.findUnique({
        where: { id: session.projectId },
        select: { machineId: true, workingDir: true, machine: { select: { status: true } } },
      });
      if (p) {
        return {
          machineId: p.machineId,
          workingDir: p.workingDir,
          cliType,
          machineStatus: p.machine.status,
        };
      }
    }
    return null;
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
    // back; if the machine is offline or the adapter doesn't implement
    // Cloner, the session remains a history-only fork (no externalId)
    // and the next prompt starts a fresh CLI conversation. The clone
    // runs in the SOURCE session's project (a fork stays in the same
    // workdir — that's what makes the cwd-keyed on-disk state valid).
    const routing = src.externalId ? await this.resolveRouting(src) : null;
    if (src.externalId && routing) {
      const wire: WireCommand = {
        id: randomUUID(),
        sessionId: dto.id,
        kind: 'clone-session',
        clone: {
          srcExternalId: src.externalId,
          turnIndex: prefix.length,
        },
        workingDir: routing.workingDir ?? undefined,
        cliType: routing.cliType,
      };
      try {
        await this.redis.publish(
          streamKeys.runnerCommand(routing.machineId, routing.cliType),
          wire,
        );
      } catch (err) {
        // Don't fail the fork if Redis hiccups — the session row is
        // already there; the user can retry by sending a prompt (which
        // triggers a fresh CLI run regardless).
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
    // Read on one client → withdraw the completion banner from phones.
    // Fire-and-forget: a push failure must not affect the read.
    void this.push.clearSessionNotification(dto);
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

  /**
   * Flip a session to `active` because a chunk arrived for `commandId` —
   * but ONLY while that command is still running.
   *
   * Every non-terminal chunk takes this path, and without the guard a
   * chunk that lands AFTER its turn finished silently un-finalizes the
   * session: status goes back to `active` and `unread` is cleared, so the
   * sidebar dot never resolves, the completion notification is suppressed,
   * and `queueDrainer` refuses to drain that session forever (it reads
   * `status === 'active'` as "mid-turn"). Observed in the wild on sessions
   * stuck for over a month.
   *
   * Two real producers of late chunks, which is why this is keyed on the
   * COMMAND's terminal state rather than "have we seen a final yet":
   *   - Claude Code's bridge re-announces `system/init` from a
   *     fire-and-forget async path that can land after the turn's
   *     `result` (measured: it lands after, every time).
   *   - Background sub-agent flows legitimately keep streaming after an
   *     inner `result`, so "anything after a final is bogus" would be
   *     wrong for them.
   *
   * Returns null when the write was skipped, so callers can skip the
   * follow-on side effects too.
   */
  async setActiveForCommand(sessionId: string, commandId: string) {
    const cmd = await this.prisma.command.findUnique({
      where: { id: commandId },
      select: { status: true },
    });
    // Unknown command (at-least-once delivery racing the command insert)
    // keeps the historical behaviour — better a spurious `active` than a
    // turn that never shows as running at all.
    if (cmd && (TERMINAL_COMMAND_STATUSES as readonly string[]).includes(cmd.status)) {
      return null;
    }
    return this.setStatus(sessionId, 'active', { unread: false });
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
      // `id` breaks createdAt ties so the ordering is total. Two turns can
      // share a millisecond, and cursor pagination against a non-unique
      // sort silently skips or repeats rows at the page boundary.
      const recent = await this.prisma.command.findMany({
        where: { sessionId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: tailCommands + 1,
      });
      hasMore = recent.length > tailCommands;
      commands = recent.slice(0, tailCommands).reverse();
    } else {
      commands = await this.prisma.command.findMany({
        where: { sessionId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
      // A tail window always reaches the newest turn — that is what makes
      // live append, reconnect backfill and stick-to-bottom safe on this
      // path. Reported explicitly so clients can key the invariant off one
      // flag regardless of which load path produced the window.
      hasMoreNewer: false,
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
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      cursor: { id: beforeCommandId },
      skip: 1,
      take: limit + 1,
    });
    const hasMore = older.length > limit;
    const commands = older.slice(0, limit).reverse();
    return {
      commands: await this.withAttachments(commands),
      chunks: await this.chunksForCommands(commands.map((c) => c.id)),
      hasMore,
    };
  }

  /**
   * Fetch the N commands NEWER than `afterCommandId` — the forward mirror
   * of `getOlderHistory`. Only reachable when the viewer holds a window
   * that does NOT reach the newest turn (a deep-linked window); a
   * tail-anchored window has nothing newer to page.
   */
  async getNewerHistory(userId: string, id: string, afterCommandId: string, limit: number) {
    await this.get(userId, id); // auth guard
    const newer = await this.prisma.command.findMany({
      where: { sessionId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      cursor: { id: afterCommandId },
      skip: 1,
      take: limit + 1,
    });
    const hasMore = newer.length > limit;
    const commands = newer.slice(0, limit);
    return {
      commands: await this.withAttachments(commands),
      chunks: await this.chunksForCommands(commands.map((c) => c.id)),
      hasMore,
    };
  }

  /**
   * Return a window of commands CENTRED on `commandId`, plus their chunks.
   *
   * This is the deep-link load: the ⌘K palette knows which turn matched,
   * and paging backwards from the tail to reach it would cost one
   * sequential round-trip per 20 turns and pull every intervening turn's
   * stdout. A centred window is one request with a bounded payload
   * regardless of how deep the target sits.
   *
   * Unlike every other read path, the window it returns may not contain
   * the session's newest turn — hence `hasMoreNewer`. Clients MUST treat
   * that flag as "live appends are not safe here" (see the transcript
   * window invariant in AGENTS.md), because the assumption that the
   * loaded window reaches the present is baked into live chunk append,
   * reconnect backfill, and stick-to-bottom scrolling.
   */
  async getWindowAround(
    userId: string,
    id: string,
    commandId: string,
    before: number,
    after: number,
  ) {
    const session = await this.get(userId, id);
    // Scope the anchor to this session: a command id from ANOTHER session
    // would otherwise page against the wrong thread, and the caller's
    // own session guard above wouldn't catch it.
    const anchor = await this.prisma.command.findFirst({
      where: { id: commandId, sessionId: id },
    });
    if (!anchor) throw new NotFoundException('command not found in this session');

    // Take limit+1 on each side to learn whether more exists without a
    // second count query — same trick as the tail path.
    const [olderRows, newerRows] = await Promise.all([
      this.prisma.command.findMany({
        where: { sessionId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        cursor: { id: commandId },
        skip: 1,
        take: before + 1,
      }),
      this.prisma.command.findMany({
        where: { sessionId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        cursor: { id: commandId },
        skip: 1,
        take: after + 1,
      }),
    ]);

    const hasMore = olderRows.length > before;
    const hasMoreNewer = newerRows.length > after;
    // `olderRows` comes back newest-first; flip it so the whole window is
    // ascending like every other command list the clients render.
    const commands = [
      ...olderRows.slice(0, before).reverse(),
      anchor,
      ...newerRows.slice(0, after),
    ];

    return {
      session: SessionService.toDto(session),
      commands: await this.withAttachments(commands),
      chunks: await this.chunksForCommands(commands.map((c) => c.id)),
      hasMore,
      hasMoreNewer,
    };
  }

  /** Chunks for a set of commands, in the (commandId, seq) order the
   *  viewers concatenate deltas in. */
  private async chunksForCommands(commandIds: string[]) {
    if (commandIds.length === 0) return [];
    return this.prisma.resultChunk.findMany({
      where: { commandId: { in: commandIds } },
      orderBy: [{ commandId: 'asc' }, { seq: 'asc' }],
    });
  }
}
