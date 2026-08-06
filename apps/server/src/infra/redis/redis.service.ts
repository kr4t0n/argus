import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { streamMaxLen } from '@argus/shared-types';
import { isIP } from 'node:net';
import Redis, { RedisOptions } from 'ioredis';

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
 * Mask the password in a connection string so it can be logged. `REDIS_URL`
 * carries credentials in prod (`rediss://default:PASSWORD@host:6379`), and a
 * log sink is not a secret store. The username is kept — it is usually just
 * `default` and it makes the line useful for debugging. Anything unparseable
 * is returned as-is: this is only ever a log string, and ioredis accepts
 * non-URL forms (a bare port, `host:port`) that `URL` rejects.
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.password) return url;
    u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Socket-liveness settings applied to every connection.
 *
 * A managed Redis behind a shared proxy (Redis Cloud, Upstash) can drop a
 * connection without ever sending a FIN, leaving the socket open forever
 * from Node's side. With `maxRetriesPerRequest: null` a blocking
 * XREADGROUP on such a half-open socket never settles AND never emits
 * 'error', so the consumer loop awaiting it parks permanently: nothing in
 * the logs, no reconnect, the consumer simply stops issuing reads.
 * Observed live — the lifecycle and result readers sat at 52 minutes idle
 * while the background reader on a sibling connection stayed at 2s, so
 * every machine showed offline while the sidecars were polling happily.
 *
 * Three layers, each covering the previous one's blind spot:
 *
 *  - `keepAlive` puts TCP probes on the wire, so a peer that vanished is
 *    eventually noticed by the kernel even with no application traffic.
 *  - `socketTimeout` destroys the stream when a written command receives
 *    no bytes at all inside the window. This is the layer that actually
 *    recovers a half-open socket: ioredis reconnects and the loop
 *    resumes. It arms only while a command is in flight and re-arms only
 *    while the command queue is non-empty, so an idle connection is never
 *    torn down. It MUST stay above the longest BLOCK window (5s) plus
 *    link RTT, or it would kill healthy blocking reads.
 *  - `blockingTimeout` enables ioredis's client-side deadline for
 *    blocking commands. It resolves the promise with `null` — the exact
 *    shape every loop already reads as "nothing this cycle" — so a loop
 *    cannot park on an await even if socket teardown is delayed.
 *
 * `blockingTimeoutGrace` is deliberately far above the stock 100ms. The
 * effective deadline for a BLOCK-carrying command is BLOCK + grace, and a
 * spurious fire is not free: Redis may have already moved a batch into
 * this consumer's PEL, and resolving `null` locally abandons entries that
 * then stay pending forever. At the ~150ms RTT this fleet sees to a
 * managed endpoint, a 100ms grace sits inside the noise; 5s makes a false
 * fire implausible while still bounding a genuine wedge to ~10s.
 */
const KEEPALIVE_MS = 30_000;
const SOCKET_TIMEOUT_MS = 15_000;
const BLOCKING_TIMEOUT_MS = 15_000;
const BLOCKING_TIMEOUT_GRACE_MS = 5_000;

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
  /** Set on shutdown so the expected teardown doesn't log as churn. */
  private closing = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');
    const opts: RedisOptions = {
      maxRetriesPerRequest: null,
      lazyConnect: false,
      keepAlive: KEEPALIVE_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      blockingTimeout: BLOCKING_TIMEOUT_MS,
      blockingTimeoutGrace: BLOCKING_TIMEOUT_GRACE_MS,
      ...tlsOptions(url),
    };
    this._cmd = this.open(url, opts, 'cmd');
    this._read = this.open(url, opts, 'read');
    this._readResults = this.open(url, opts, 'readResults');
    this._readBackground = this.open(url, opts, 'readBackground');
    await this._cmd.ping();
    this.logger.log(`Connected to ${redactUrl(url)}`);
  }

  /**
   * Build one connection and wire its lifecycle events.
   *
   * Only 'error' was logged before, which is exactly the event a
   * half-open socket never emits — the teardown that matters is the
   * silent one. Logging 'close'/'reconnecting' turns a recovered drop
   * into visible churn rather than an unexplained gap in consumption,
   * which is the signal that was missing while the readers were wedged.
   * The `error` line keeps its original wording (`redis <label> error:`)
   * because the runbook greps for it.
   */
  private open(url: string, opts: RedisOptions, label: string): Redis {
    const conn = new Redis(url, opts);
    conn.on('error', (err: Error) => this.logger.error(`redis ${label} error: ${err.message}`));
    conn.on('close', () => {
      if (!this.closing) this.logger.warn(`redis ${label} socket closed`);
    });
    conn.on('reconnecting', (ms: number) => {
      if (!this.closing) this.logger.warn(`redis ${label} reconnecting in ${ms}ms`);
    });
    return conn;
  }

  async onModuleDestroy() {
    this.closing = true;
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
