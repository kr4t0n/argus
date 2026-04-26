import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { streamMaxLen } from '@argus/shared-types';
import Redis from 'ioredis';

/**
 * Thin Redis wrapper with Streams helpers. We maintain two clients:
 *   - `cmd`: for XADD/XACK/DEL/etc. (shared)
 *   - `read`: exclusively for blocking XREAD(GROUP) calls.
 *
 * ioredis requires a dedicated connection for blocking commands because
 * each XREAD/XREADGROUP call with BLOCK parks the socket.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private _cmd!: Redis;
  private _read!: Redis;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const opts = { maxRetriesPerRequest: null, lazyConnect: false };
    this._cmd = new Redis(url, opts);
    this._read = new Redis(url, opts);
    this._cmd.on('error', (err) => this.logger.error(`redis cmd error: ${err.message}`));
    this._read.on('error', (err) => this.logger.error(`redis read error: ${err.message}`));
    await this._cmd.ping();
    this.logger.log(`Connected to ${url}`);
  }

  async onModuleDestroy() {
    await this._cmd?.quit();
    await this._read?.quit();
  }

  get cmd(): Redis {
    return this._cmd;
  }

  get read(): Redis {
    return this._read;
  }

  /** Publish a JSON payload as a single-field `data` entry on a stream.
   *  The MAXLEN cap is keyed off the stream name via `streamMaxLen`
   *  so each stream class gets a size appropriate for its volume and
   *  consumer-lag tolerance. */
  async publish(stream: string, payload: unknown): Promise<string> {
    return (await this._cmd.xadd(
      stream,
      'MAXLEN',
      '~',
      String(streamMaxLen(stream)),
      '*',
      'data',
      JSON.stringify(payload),
    )) as string;
  }

  /** Idempotent consumer group creation. */
  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this._cmd.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('BUSYGROUP')) throw err;
    }
  }
}
