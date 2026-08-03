import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { streamMaxLen } from '@argus/shared-types';
import { isIP } from 'node:net';
import Redis from 'ioredis';

/**
 * Build the TLS options for a `rediss://` URL, pinning the SNI server name.
 *
 * ioredis only sets `tls: true` (a boolean) when it sees the `rediss://`
 * scheme, and its connector then does `Object.assign(connectionOptions,
 * options.tls)` — assigning a boolean copies nothing, so the socket is opened
 * as `tls.connect({ host, port })`. Node sends the SNI extension ONLY when
 * `servername` is set explicitly; `tls.connect` has no fallback to `host`
 * (see the `if (options.servername)` guard in lib/_tls_wrap.js). Net result:
 * the server handshook without SNI while the Go sidecars — go-redis derives
 * `TLSConfig.ServerName` from the URL host — sent it correctly.
 *
 * That asymmetry breaks managed Redis (Upstash, Redis Cloud) where a shared
 * TLS terminator fronts many tenants and needs SNI to pick the certificate:
 * sidecars connect, the server does not. Certificate *verification* was never
 * affected — `rejectUnauthorized` stays on and `checkServerIdentity` validates
 * against `host` — so this is cert selection, not an auth downgrade.
 *
 * An IP literal must not appear in SNI (RFC 6066), and Node warns (DEP0123)
 * and will eventually ignore it, so leave `servername` unset in that case and
 * let the connection behave as it did before.
 */
function tlsOptions(url: string): { tls?: { servername: string } } {
  if (!url.startsWith('rediss://')) return {};
  // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`), which
  // `isIP` does not recognise — strip them or the literal slips into SNI.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return isIP(host) ? {} : { tls: { servername: host } };
}

/**
 * Thin Redis wrapper with Streams helpers. We maintain one shared
 * command client plus one DEDICATED connection per blocking consumer
 * loop:
 *   - `cmd`: for XADD/XACK/DEL/etc. (shared)
 *   - `read`: the lifecycle+notify loop (MachineService)
 *   - `readResults`: the result-ingestor loop
 *   - `readBackground`: the background-task loop
 *
 * ioredis requires a dedicated connection for blocking commands because
 * each XREAD/XREADGROUP call with BLOCK parks the socket — and two
 * loops SHARING one connection serialize behind each other's BLOCK
 * window (up to 5s of added latency per hop). That was masked while
 * per-agent heartbeats kept the lifecycle stream busy; with runner
 * sidecars (Phase 3) the steady state is quiet, so every loop gets its
 * own socket. Three extra connections per server process — noise.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private _cmd!: Redis;
  private _read!: Redis;
  private _readResults!: Redis;
  private _readBackground!: Redis;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const opts = { maxRetriesPerRequest: null, lazyConnect: false, ...tlsOptions(url) };
    this._cmd = new Redis(url, opts);
    this._read = new Redis(url, opts);
    this._readResults = new Redis(url, opts);
    this._readBackground = new Redis(url, opts);
    this._cmd.on('error', (err) => this.logger.error(`redis cmd error: ${err.message}`));
    this._read.on('error', (err) => this.logger.error(`redis read error: ${err.message}`));
    this._readResults.on('error', (err) =>
      this.logger.error(`redis readResults error: ${err.message}`),
    );
    this._readBackground.on('error', (err) =>
      this.logger.error(`redis readBackground error: ${err.message}`),
    );
    await this._cmd.ping();
    this.logger.log(`Connected to ${url}`);
  }

  async onModuleDestroy() {
    await this._cmd?.quit();
    await this._read?.quit();
    await this._readResults?.quit();
    await this._readBackground?.quit();
  }

  get cmd(): Redis {
    return this._cmd;
  }

  get read(): Redis {
    return this._read;
  }

  get readResults(): Redis {
    return this._readResults;
  }

  get readBackground(): Redis {
    return this._readBackground;
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
