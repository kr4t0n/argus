import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type {
  ResultChunk,
  ResultChunkDTO,
  SessionExternalIdEvent,
} from '@argus/shared-types';
import { consumerGroups, streamKeys } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { SessionService } from '../session/session.service';
import { CommandService } from '../command/command.service';

const CONSUMER = 'server-1';
const REFRESH_AGENT_STREAMS_MS = 5_000;

type ResultEnvelope = ResultChunk | SessionExternalIdEvent;

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
        const res = (await (this.redis.read as any).xreadgroup(...args)) as
          | Array<[string, Array<[string, string[]]>]>
          | null;
        if (!res) continue;
        for (const [stream, entries] of res) {
          for (const [msgId, fields] of entries) {
            try {
              const payload = parseData(fields);
              if (payload) await this.handle(payload as ResultEnvelope);
            } catch (err) {
              this.logger.error(
                `failed to handle result on ${stream}: ${(err as Error).message}`,
              );
            }
            await this.redis.cmd.xack(stream, consumerGroups.server, msgId);
          }
        }
      } catch (err) {
        if (this.running) {
          this.logger.error(`result loop error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  private async handle(ev: ResultEnvelope) {
    if ((ev as SessionExternalIdEvent).kind === 'session-external-id') {
      const e = ev as SessionExternalIdEvent;
      await this.sessions.setExternalId(e.sessionId, e.externalId);
      return;
    }

    const chunk = ev as ResultChunk;
    await this.prisma.resultChunk.create({
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
    }).catch((err) => {
      // unique-key collision is fine (at-least-once delivery) — log other errors.
      if (!String(err.message).includes('Unique')) throw err;
    });

    const dto: ResultChunkDTO = { ...chunk };
    this.gateway.emitChunk(dto);

    if (chunk.isFinal || chunk.kind === 'final' || chunk.kind === 'error') {
      const status = chunk.kind === 'error' ? 'failed' : 'completed';
      await this.prisma.command
        .update({
          where: { id: chunk.commandId },
          data: { status, completedAt: new Date() },
        })
        .then((cmd) => this.gateway.emitCommandUpdated(CommandService.toDto(cmd)))
        .catch(() => {});
      await this.sessions.setStatus(chunk.sessionId, status === 'failed' ? 'failed' : 'idle');
    } else {
      await this.sessions.setStatus(chunk.sessionId, 'active');
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
