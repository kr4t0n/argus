import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { consumerGroups, streamKeys } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { TerminalService } from './terminal.service';

const CONSUMER = 'server-1';
const REFRESH_AGENT_STREAMS_MS = 5_000;

/**
 * Consumes every agent's `agent:{id}:term:out` stream and fans messages
 * out to the WS room `terminal:{terminalId}`. Mirrors the architecture
 * of ResultIngestorService — one global consumer with a periodically
 * refreshed stream list.
 *
 * Latency note: terminal traffic flows browser → server-WS → Redis →
 * sidecar → PTY → sidecar → Redis → server → browser-WS. With Upstash
 * (regional) you'll see ~50-150ms RTT per keystroke echo. That's fine
 * for typing commands; it's noticeably laggy for full-screen TUIs like
 * `vim` or `htop`. If you hit that wall, swap `terminal:out` to a
 * direct sidecar→server WebSocket — see the "Terminal" section in
 * AGENTS.md.
 */
@Injectable()
export class TerminalOutputConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TerminalOutputConsumer.name);
  private running = false;
  private streams: string[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
    private readonly terminals: TerminalService,
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
    const agents = await this.prisma.agent.findMany({
      where: { capabilities: { array_contains: 'terminal' } as any },
      select: { id: true },
    }).catch(async () => {
      // Fallback: some Postgres versions / Prisma quirks make
      // array_contains awkward. Just enumerate every agent — there
      // aren't that many, and ensureGroup is idempotent.
      return this.prisma.agent.findMany({ select: { id: true } });
    });
    const next = agents.map((a) => streamKeys.terminalOut(a.id));
    for (const s of next) {
      await this.redis.ensureGroup(s, consumerGroups.terminalOut);
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
          consumerGroups.terminalOut,
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
              if (payload) await this.handle(payload as any);
            } catch (err) {
              this.logger.error(
                `failed to handle terminal output on ${stream}: ${(err as Error).message}`,
              );
            }
            await this.redis.cmd.xack(stream, consumerGroups.terminalOut, msgId);
          }
        }
      } catch (err) {
        if (this.running) {
          this.logger.error(`terminal-output loop error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  private async handle(ev: { kind: string; terminalId: string } & Record<string, unknown>) {
    if (ev.kind === 'terminal-output') {
      const seq = Number(ev.seq);
      const data = String(ev.data ?? '');
      this.gateway.emitTerminalOutput({ terminalId: ev.terminalId, seq, data });
      // Lazy: bump status to 'open' on first output. Avoids a race
      // where the sidecar emits output before the open ACK round-trip.
      this.terminals.markOpenIfNeeded(ev.terminalId).catch(() => {});
      return;
    }
    if (ev.kind === 'terminal-closed') {
      const exitCode = Number(ev.exitCode ?? 0);
      const reason = ev.reason as string | undefined;
      await this.terminals.markClosed(ev.terminalId, exitCode, reason);
      return;
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
