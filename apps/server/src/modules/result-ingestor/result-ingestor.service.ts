import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type {
  AgentType,
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
import { SessionService } from '../session/session.service';
import { CommandService } from '../command/command.service';

const CONSUMER = 'server-1';
const REFRESH_AGENT_STREAMS_MS = 5_000;

type ResultEnvelope = ResultChunk | SessionExternalIdEvent | SessionCloneFailedEvent;

/**
 * Consumes every agent's `agent:{id}:result` stream, persists each chunk,
 * and relays it to the WS room `session:{sessionId}` for the live UI.
 *
 * We maintain a single XREADGROUP call across all agent streams. The list of
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
  ) {}

  async onModuleInit() {
    await this.refreshStreams();
    this.refreshTimer = setInterval(() => this.refreshStreams(), REFRESH_AGENT_STREAMS_MS);
    this.running = true;
    this.loopPromise = this.consumeLoop();
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await Promise.race([this.loopPromise, new Promise((r) => setTimeout(r, 6_000))]);
  }

  private async refreshStreams() {
    const agents = await this.prisma.agent.findMany({ select: { id: true } });
    const next = agents.map((a) => streamKeys.result(a.id));
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
        const res = (await (this.redis.read as any).xreadgroup(...args)) as Array<
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
          // A destroyed agent has its result stream DELed (MachineService
          // .deleteAgentStreams), and a Redis flush drops every group. Either
          // leaves a stream in our read set with no consumer group, and a
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
      select: { agent: { select: { type: true } } },
    });
    if (!cmd) return undefined;
    const parsed = parseUsage(cmd.agent.type as AgentType, meta);
    if (!parsed) return undefined;
    return parsed as unknown as Prisma.InputJsonValue;
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

    if (chunk.isFinal || chunk.kind === 'final' || chunk.kind === 'error') {
      const status = chunk.kind === 'error' ? 'failed' : 'completed';
      // Denormalize parsed token usage onto the Command row so /me/usage
      // can SUM a column instead of re-parsing every final chunk's
      // `meta` blob. Finals are rare (one per turn), so the extra
      // read-then-update is cheap; the read is needed to pick the
      // adapter-specific parser without trusting the chunk envelope.
      const usageData = await this.computeCommandUsage(chunk);
      await this.prisma.command
        .update({
          where: { id: chunk.commandId },
          data: {
            status,
            completedAt: new Date(),
            ...(usageData !== undefined ? { usage: usageData } : {}),
          },
        })
        .then((cmd) => this.gateway.emitCommandUpdated(CommandService.toDto(cmd)))
        .catch(() => {});
      // Terminal: success lands lifecycle-`idle`, error lands `failed`,
      // and either way the result is unread until the user opens it —
      // that `unread` flag is what surfaces the sidebar dot.
      await this.sessions.setStatus(chunk.sessionId, status === 'failed' ? 'failed' : 'idle', {
        unread: true,
      });
    } else {
      // A fresh turn is running: clear any prior unread result so the
      // dot doesn't linger while the amber "active" indicator shows.
      await this.sessions.setStatus(chunk.sessionId, 'active', { unread: false });
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
