import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type {
  AgentType,
  AvailableAdapter,
  ResultChunk,
  ResultChunkDTO,
  SessionCloneFailedEvent,
  SessionExternalIdEvent,
} from '@argus/shared-types';
import { consumerGroups, parseUsage, streamKeys } from '@argus/shared-types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { SessionService, TERMINAL_COMMAND_STATUSES } from '../session/session.service';
import { CommandService } from '../command/command.service';
import { PushService } from '../push/push.service';
import { SearchService } from '../search/search.service';

const CONSUMER = 'server-1';
const REFRESH_RUNNER_STREAMS_MS = 5_000;

/**
 * Chunk kinds that prove the model is still WORKING, as opposed to status
 * noise. Only these re-open a command that already finalized — see
 * `reopenIfStillWorking`.
 *
 * `stderr` is deliberately absent: a CLI can write a warning line as it
 * exits, and re-opening on that would strand the command `running` with
 * nothing left to finalize it — the exact failure the finalize guard
 * exists to prevent.
 */
const WORK_CHUNK_KINDS = ['delta', 'tool', 'stdout'] as const;

/** Terminal statuses a command may be re-opened FROM. `cancelled` is
 *  excluded on purpose: the user ended that turn, and trailing output
 *  must not resurrect it. */
const REOPENABLE_STATUSES = ['completed', 'failed'] as const;

type ResultEnvelope = ResultChunk | SessionExternalIdEvent | SessionCloneFailedEvent;

/**
 * Consumes every runner result stream (`machine:{id}:cli:{type}:result`,
 * one per installed CLI on each machine), persists each chunk, and relays
 * it to the WS room `session:{sessionId}` for the live UI.
 *
 * We maintain a single XREADGROUP call across all result streams. The list of
 * streams is refreshed every few seconds so newly registered sidecars are
 * picked up automatically.
 */
@Injectable()
export class ResultIngestorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResultIngestorService.name);
  private running = false;
  private streams: string[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
    private readonly sessions: SessionService,
    private readonly push: PushService,
    private readonly search: SearchService,
  ) {}

  async onModuleInit() {
    await this.refreshStreams();
    this.refreshTimer = setInterval(() => this.refreshStreams(), REFRESH_RUNNER_STREAMS_MS);
    this.running = true;
    this.loopPromise = this.consumeLoop();
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await Promise.race([this.loopPromise, new Promise((r) => setTimeout(r, 6_000))]);
  }

  private async refreshStreams() {
    // Since Phase 4 every machine is a runner: results arrive per
    // machine × installed CLI (`machine:{id}:cli:{type}:result`). The
    // stream set is a function of the machine roster alone — no more
    // per-agent streams, no Agent-table poll. Ingest is shape-agnostic
    // (chunks carry commandId/sessionId).
    const machines = await this.prisma.machine.findMany({
      where: { deletedAt: null },
      select: { id: true, availableAdapters: true },
    });
    const next: string[] = [];
    for (const m of machines) {
      const adapters = (m.availableAdapters ?? []) as unknown as AvailableAdapter[];
      if (!Array.isArray(adapters)) continue;
      for (const ad of adapters) {
        if (ad?.type) next.push(streamKeys.runnerResult(m.id, ad.type));
      }
    }
    for (const s of next) {
      await this.redis.ensureGroup(s, consumerGroups.server);
    }
    this.streams = next;
  }

  private async consumeLoop() {
    while (this.running) {
      if (this.streams.length === 0) {
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      try {
        const args = [
          'GROUP',
          consumerGroups.server,
          CONSUMER,
          'COUNT',
          200,
          'BLOCK',
          2_000,
          'STREAMS',
          ...this.streams,
          ...this.streams.map(() => '>'),
        ] as unknown as [string, ...string[]];
        const res = (await (this.redis.readResults as any).xreadgroup(...args)) as Array<
          [string, Array<[string, string[]]>]
        > | null;
        if (!res) continue;
        for (const [stream, entries] of res) {
          for (const [msgId, fields] of entries) {
            try {
              const payload = parseData(fields);
              if (payload) await this.handle(payload as ResultEnvelope);
            } catch (err) {
              this.logger.error(`failed to handle result on ${stream}: ${(err as Error).message}`);
            }
            await this.redis.cmd.xack(stream, consumerGroups.server, msgId);
          }
        }
      } catch (err) {
        if (this.running) {
          const msg = (err as Error).message;
          // An emergency DEL of a runner result stream (the documented
          // Redis-full recovery move) or a Redis flush drops its consumer
          // groups. Either leaves a stream in our read set with no group, and a
          // single NOGROUP fails the *whole* multi-stream XREADGROUP — so
          // one destroyed agent would otherwise stall live streaming for
          // every session until the 5s timed refresh. Re-sync the stream
          // list immediately (drops deleted agents, re-ensures groups for
          // survivors) and retry now instead of backing off.
          if (msg.includes('NOGROUP')) {
            try {
              await this.refreshStreams();
              continue;
            } catch {
              // refresh failed too — fall through to the backoff sleep.
            }
          }
          this.logger.error(`result loop error: ${msg}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  /**
   * Compute the normalized TokenUsage value to write onto Command.usage
   * for a finalizing chunk. Returns:
   *   - a JSON object if the chunk has a parseable usage payload,
   *   - `undefined` if there's nothing to write (so the update can omit
   *     the column rather than overwrite a previously-written value).
   *
   * `undefined` is the deliberate "leave alone" signal — `null` would
   * blank the column, which we don't want for retry / out-of-order
   * deliveries where the usage already landed.
   */
  private async computeCommandUsage(
    chunk: ResultChunk,
  ): Promise<Prisma.InputJsonValue | undefined> {
    const meta = (chunk.meta ?? null) as Record<string, unknown> | null;
    if (!meta) return undefined;
    const cmd = await this.prisma.command.findUnique({
      where: { id: chunk.commandId },
      select: { session: { select: { cliType: true } } },
    });
    if (!cmd) return undefined;
    // Session.cliType is the pinned CLI (Phase 1). Pre-backfill rows
    // whose session predates cliType simply yield no usage type — the
    // Agent-derived fallback retired with the agentId columns (Phase 5).
    const parsed = parseUsage(cmd.session.cliType as AgentType, meta);
    if (!parsed) return undefined;
    return parsed as unknown as Prisma.InputJsonValue;
  }

  /**
   * A chunk arrived for a command that has already finalized. Decide
   * whether the turn is in fact STILL RUNNING, and if so re-open it.
   *
   * Two very different producers land here:
   *
   *   - A TRAILING announce. Claude Code's bridge re-announces
   *     `system/init` from a fire-and-forget async path that can land
   *     after the turn's `result`. Nothing follows it — the turn really
   *     is over — so re-opening would leave the command `running`
   *     forever.
   *
   *   - An INNER result. A CLI that restarts mid-turn emits a `result`
   *     for the abandoned run and then keeps working for minutes.
   *     Observed in production: a command finalized at 08:50:28 while 42
   *     more chunks streamed in until 08:52:10. The client faithfully
   *     honours the server's "completed" and renders the turn as
   *     done-and-empty until a hard refresh. `splitDeltas` has always
   *     known a `final` may be an inner boundary; the ingestor did not.
   *
   * They are indistinguishable at the moment the chunk arrives, so the
   * discriminator is the chunk KIND: a trailing announce is only ever
   * `progress`, while real model work is `delta` / `tool` / `stdout`.
   * That costs a little latency — recovery happens at the turn's next
   * delta rather than instantly — but it cannot strand a command.
   */
  private async reopenIfStillWorking(chunk: ResultChunk): Promise<void> {
    if (!(WORK_CHUNK_KINDS as readonly string[]).includes(chunk.kind)) return;
    const reopened = await this.prisma.command.updateMany({
      where: { id: chunk.commandId, status: { in: [...REOPENABLE_STATUSES] } },
      data: { status: 'running', completedAt: null },
    });
    if (reopened.count === 0) return; // cancelled, or someone beat us to it
    this.logger.warn(
      `command ${chunk.commandId} re-opened: ${chunk.kind} arrived after it finalized`,
    );
    const cmd = await this.prisma.command.findUnique({ where: { id: chunk.commandId } });
    if (cmd) this.gateway.emitCommandUpdated(CommandService.toDto(cmd));
    // The session followed the command down to idle at finalize; bring it
    // back so the sidebar shows the turn as live again.
    const dto = await this.sessions.setStatus(chunk.sessionId, 'active', { unread: false });
    void this.push.clearSessionNotification(dto);
  }

  private async handle(ev: ResultEnvelope) {
    const kind = (ev as { kind?: string }).kind;
    if (kind === 'session-external-id') {
      const e = ev as SessionExternalIdEvent;
      await this.sessions.setExternalId(e.sessionId, e.externalId);
      return;
    }
    if (kind === 'session-clone-failed') {
      const e = ev as SessionCloneFailedEvent;
      // Look up the owning user so the gateway can scope the toast to
      // their room. Sidecar doesn't know userId; the Session row does.
      const sess = await this.prisma.session.findUnique({
        where: { id: e.sessionId },
        select: { userId: true },
      });
      if (sess) {
        this.gateway.emitSessionCloneFailed({
          sessionId: e.sessionId,
          userId: sess.userId,
          reason: e.reason,
        });
      }
      return;
    }

    const chunk = ev as ResultChunk;
    await this.prisma.resultChunk
      .create({
        data: {
          id: chunk.id,
          commandId: chunk.commandId,
          seq: chunk.seq,
          kind: chunk.kind,
          delta: chunk.delta ?? null,
          content: chunk.content ?? null,
          meta: (chunk.meta as any) ?? undefined,
          ts: new Date(chunk.ts),
        },
      })
      .catch((err) => {
        // unique-key collision is fine (at-least-once delivery) — log other errors.
        if (!String(err.message).includes('Unique')) throw err;
      });

    const dto: ResultChunkDTO = { ...chunk };
    this.gateway.emitChunk(dto);

    // Lock-screen Live Activity upkeep (no-op without registered
    // activity tokens; throttled internally).
    this.push.noteLiveActivityChunk(chunk);

    if (chunk.isFinal || chunk.kind === 'final' || chunk.kind === 'error') {
      const status = chunk.kind === 'error' ? 'failed' : 'completed';
      // Denormalize parsed token usage onto the Command row so /me/usage
      // can SUM a column instead of re-parsing every final chunk's
      // `meta` blob. Finals are rare (one per turn), so the extra
      // read-then-update is cheap; the read is needed to pick the
      // adapter-specific parser without trusting the chunk envelope.
      const usageData = await this.computeCommandUsage(chunk);
      // First terminal chunk wins. A turn can legitimately deliver more
      // than one terminal signal — sidecars ≤ 0.2.7-rc.1 emit both the
      // CLI's result final and a bare process-exit final, and Redis
      // delivery is at-least-once — but finalizing twice double-fires
      // the push notification. The status guard makes everything below
      // run exactly once per turn; the CLI's own final always precedes
      // the synthetic one, so the rich chunk (usage, real
      // success/failure) is the one that wins.
      const finalized = await this.prisma.command
        .updateMany({
          where: {
            id: chunk.commandId,
            status: { notIn: [...TERMINAL_COMMAND_STATUSES] },
          },
          data: {
            status,
            completedAt: new Date(),
            ...(usageData !== undefined ? { usage: usageData } : {}),
          },
        })
        .catch(() => ({ count: 0 }));
      if (finalized.count === 0) {
        // Already terminal: a duplicate final for a finished turn (the
        // first one did all the work below), or the process-exit final
        // of a CANCELLED turn. Cancel marks the Command row up front
        // but only chunk ingestion knows when the CLI actually stopped,
        // so the session flip + lock-screen cleanup still run for it —
        // without the unread dot or a push: the user ended that turn
        // themselves.
        const cmd = await this.prisma.command.findUnique({
          where: { id: chunk.commandId },
          select: { status: true },
        });
        if (cmd?.status === 'cancelled') {
          const dto = await this.sessions.setStatus(chunk.sessionId, 'idle', { unread: false });
          void this.push.clearSessionNotification(dto);
          void this.push.endLiveActivity(chunk.sessionId, false);
        }
        return;
      }
      await this.prisma.command
        .findUnique({ where: { id: chunk.commandId } })
        .then((cmd) => cmd && this.gateway.emitCommandUpdated(CommandService.toDto(cmd)))
        .catch(() => {});
      // Materialize this turn's full-text search doc. Sits inside the
      // finalize-once guard so it runs exactly once per turn, and after
      // the status write so every chunk is already persisted — the doc
      // is assembled from ResultChunk rows, so indexing earlier would
      // capture a half-streamed answer. Fire-and-forget: a search-index
      // failure must never stall chunk ingestion.
      this.search.indexCommandSafe(chunk.commandId);
      // Terminal: success lands lifecycle-`idle`, error lands `failed`,
      // and either way the result is unread until the user opens it —
      // that `unread` flag is what surfaces the sidebar dot.
      const dto = await this.sessions.setStatus(
        chunk.sessionId,
        status === 'failed' ? 'failed' : 'idle',
        { unread: true },
      );
      // Same trigger point as the web's desktop notification: a turn
      // reached a terminal state. Fire-and-forget — a push failure must
      // never affect ingestion. The final chunk's content (claude-code:
      // the canonical answer; codex: absent) seeds the alert-body
      // preview so the happy path needs no extra DB read.
      void this.push.notifySessionFinished(dto, status === 'failed', {
        commandId: chunk.commandId,
        finalContent: chunk.kind === 'final' ? chunk.content : undefined,
      });
      // Resolve any lock-screen card immediately (✓/✗).
      void this.push.endLiveActivity(chunk.sessionId, status === 'failed');
    } else {
      // A fresh turn is running: clear any prior unread result so the
      // dot doesn't linger while the amber "active" indicator shows.
      //
      // GUARDED on the command still being live. A chunk can arrive after
      // its own turn finalized — Claude Code's bridge re-announces
      // `system/init` from a fire-and-forget async path that lands after
      // the turn's `result` — and without the guard that late chunk
      // silently un-finalizes the session: status back to `active`,
      // `unread` cleared. Nothing ever puts it right, because only a
      // LATER turn's final rewrites the status, so the sidebar dot spins
      // forever, the completion notification is suppressed, and
      // `queueDrainer` never drains that session again (it reads
      // `active` as "mid-turn"). Sessions were found stuck this way for
      // over a month.
      //
      // The finalize branch above has always been idempotent; this one
      // was not, and that asymmetry was the whole bug.
      const dto = await this.sessions.setActiveForCommand(chunk.sessionId, chunk.commandId);
      if (dto) {
        // Same supersedence for the phone banner: a "completed" alert
        // about a session that's running again is stale. Runs per chunk
        // but costs a Set lookup unless an alert is actually outstanding
        // (queued follow-ups / remote submits — an interactive read
        // already cleared it via markSeen).
        void this.push.clearSessionNotification(dto);
        return;
      }
      // Null means the command is already terminal. That is usually a
      // trailing announce and correctly ignored — but not always.
      await this.reopenIfStillWorking(chunk);
    }
  }
}

function parseData(fields: string[]): unknown | null {
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === 'data') {
      try {
        return JSON.parse(fields[i + 1]!);
      } catch {
        return null;
      }
    }
  }
  return null;
}
