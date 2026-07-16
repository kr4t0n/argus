import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionDTO } from '@argus/shared-types';
import * as jwt from 'jsonwebtoken';
import * as http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** Live-turn bookkeeping for one session's lock-screen activity. */
type LiveTurn = {
  commandId: string;
  toolCount: number;
  lastTool: string;
  lastPushAt: number;
  /** Armed while an update sits suppressed inside the throttle window;
   *  fires at window expiry with the then-current counters. */
  pendingFlush?: NodeJS.Timeout;
  tokens: string[];
  tokensFetchedAt: number;
};

/**
 * APNs sender for native clients. Fires a task-completion alert to every
 * device token a user has registered, from the same trigger point that
 * powers the web's desktop notifications (result-ingestor flipping a
 * session to idle/failed + unread).
 *
 * Config (all-or-nothing; the service is a silent no-op when unset, so
 * web-only deployments need zero extra setup):
 *   APNS_TEAM_ID     Apple developer team id
 *   APNS_KEY_ID      key id of the .p8 signing key
 *   APNS_KEY_BASE64  the .p8 file content, base64-encoded
 *   APNS_KEY_PATH    …or a path to the .p8 (BASE64 wins if both set)
 *   APNS_TOPIC       bundle id (default app.argus.ios)
 *   APNS_ENV         'sandbox' (default) | 'production'
 *
 * Transport is raw node:http2 (APNs requires HTTP/2; Node's fetch can't
 * speak it) with a provider JWT cached ~45 min (Apple wants 20–60 min).
 * Volume is one request per finished turn per device — a fresh session
 * per send is fine and sidesteps idle-connection reaping.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  private readonly teamId?: string;
  private readonly keyId?: string;
  private readonly key?: string;
  private readonly topic: string;
  private readonly host: string;

  private cachedProviderJwt?: { token: string; mintedAt: number };

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.teamId = config.get<string>('APNS_TEAM_ID');
    this.keyId = config.get<string>('APNS_KEY_ID');
    this.topic = config.get<string>('APNS_TOPIC') ?? 'app.argus.ios';
    this.host =
      config.get<string>('APNS_ENV') === 'production'
        ? 'https://api.push.apple.com'
        : 'https://api.sandbox.push.apple.com';

    const keyBase64 = config.get<string>('APNS_KEY_BASE64');
    const keyPath = config.get<string>('APNS_KEY_PATH');
    try {
      if (keyBase64) {
        this.key = Buffer.from(keyBase64, 'base64').toString('utf8');
      } else if (keyPath) {
        this.key = readFileSync(keyPath, 'utf8');
      }
    } catch (err) {
      this.logger.error(`failed to read APNs key: ${String(err)}`);
    }

    if (this.enabled) {
      this.logger.log(`APNs enabled (topic ${this.topic}, ${this.host})`);
    } else {
      this.logger.log('APNs not configured — push notifications disabled');
    }
  }

  get enabled(): boolean {
    return Boolean(this.teamId && this.keyId && this.key);
  }

  /**
   * Called by the result-ingestor when a turn reaches a terminal state.
   * Fire-and-forget: never throws (a push failure must not affect chunk
   * ingestion).
   */
  async notifySessionFinished(
    session: SessionDTO,
    failed: boolean,
    turn?: { commandId: string; finalContent?: string },
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      const devices = await this.prisma.deviceToken.findMany({
        where: { userId: session.userId },
      });
      if (devices.length === 0) return;

      // Completed turns carry a preview of the assistant's answer so
      // the banner is actionable without opening the app. NOTE this
      // puts answer text on the lock screen — users who care can scope
      // it with iOS Settings > Notifications > Show Previews. Failures
      // keep a fixed phrase (error text is stack-trace-y, not a
      // summary).
      const body = failed
        ? 'Turn failed'
        : ((await this.answerPreview(turn)) ?? 'Turn completed');
      const payload = JSON.stringify({
        aps: {
          alert: {
            title: session.title,
            body,
          },
          sound: 'default',
          'thread-id': session.id,
        },
        sessionId: session.id,
      });

      await Promise.allSettled(
        // Collapse id mirrors the web notification's `tag`: a newer
        // completion in the same session replaces the older banner
        // instead of stacking (and any duplicate send collapses too).
        devices.map((device) => this.send(device.token, payload, { collapseId: session.id })),
      );
    } catch (err) {
      this.logger.warn(`push fan-out failed: ${String(err)}`);
    }
  }

  /** Alert-body budget: the lock-screen banner shows ~4 lines and the
   *  long-look a bit more; APNs caps the whole payload at 4KB. */
  private static readonly ALERT_BODY_MAX = 300;

  /**
   * The turn's final answer, trimmed to banner size — or null when
   * there's no usable text (caller falls back to the fixed phrase).
   *
   * claude-code's `result` final carries the canonical answer as the
   * chunk's content. codex finals are content-less (the answer streamed
   * as deltas), so reconstruct it the way the web/iOS transcripts do
   * (DeltaSplit): the boundary is the highest tool/stdout/stderr/error
   * seq, and deltas strictly after it are the answer. Both queries ride
   * the (commandId, seq) index and run once per finished turn, and only
   * when the user actually has registered devices.
   */
  private async answerPreview(turn?: {
    commandId: string;
    finalContent?: string;
  }): Promise<string | null> {
    if (!turn) return null;
    let text = (turn.finalContent ?? '').trim();
    if (!text) {
      const boundary = await this.prisma.resultChunk.findFirst({
        where: {
          commandId: turn.commandId,
          kind: { in: ['tool', 'stdout', 'stderr', 'error'] },
        },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const deltas = await this.prisma.resultChunk.findMany({
        where: {
          commandId: turn.commandId,
          kind: 'delta',
          seq: { gt: boundary?.seq ?? -1 },
        },
        orderBy: { seq: 'asc' },
        select: { delta: true },
      });
      text = deltas
        .map((d) => d.delta ?? '')
        .join('')
        .trim();
    }
    if (!text) return null;
    // Collapse blank-line runs so markdown paragraph spacing doesn't
    // eat the banner's few visible lines.
    const collapsed = text.replace(/\r/g, '').replace(/\n{2,}/g, '\n');
    const chars = Array.from(collapsed);
    if (chars.length <= PushService.ALERT_BODY_MAX) return collapsed;
    return chars.slice(0, PushService.ALERT_BODY_MAX - 1).join('').trimEnd() + '…';
  }

  private providerJwt(): string {
    const now = Date.now();
    if (this.cachedProviderJwt && now - this.cachedProviderJwt.mintedAt < 45 * 60_000) {
      return this.cachedProviderJwt.token;
    }
    const token = jwt.sign({ iss: this.teamId!, iat: Math.floor(now / 1000) }, this.key!, {
      algorithm: 'ES256',
      keyid: this.keyId!,
    });
    this.cachedProviderJwt = { token, mintedAt: now };
    return token;
  }

  // ── Live Activities ──────────────────────────────────────────────
  //
  // The iOS client starts an ActivityKit activity for a running turn
  // and registers its per-activity push token against the session.
  // While the app is backgrounded, WE are the only thing that can move
  // the lock-screen card: throttled 'update' events as tool chunks
  // stream, and an immediate 'end' when the turn settles. The Swift
  // ContentState is `{state, toolCount, lastTool}` — key names here
  // must match it EXACTLY (ActivityKit decodes content-state with the
  // struct's Codable).

  /** Per-session live-turn bookkeeping: tool counters + push throttle +
   *  a short token-existence cache so chunk ingestion never queries
   *  Postgres more than once per window. */
  private liveTurns = new Map<string, LiveTurn>();

  private static readonly LIVE_UPDATE_MIN_MS = 15_000;
  private static readonly LIVE_TOKEN_CACHE_MS = 60_000;

  private get liveActivityTopic(): string {
    return `${this.topic}.push-type.liveactivity`;
  }

  /** Drop the token cache for a session (called on register/unregister
   *  so a fresh activity gets its first update promptly). */
  invalidateLiveTokens(sessionId: string): void {
    const entry = this.liveTurns.get(sessionId);
    if (entry) entry.tokensFetchedAt = 0;
  }

  /**
   * Called by the result-ingestor for every persisted chunk. Cheap when
   * the session has no registered activity; otherwise maintains the
   * turn's counters and pushes a throttled content-state update.
   */
  noteLiveActivityChunk(chunk: {
    sessionId: string;
    commandId: string;
    kind: string;
    content?: string;
    meta?: Record<string, unknown>;
  }): void {
    if (!this.enabled) return;
    if (chunk.kind !== 'tool') return;

    let entry = this.liveTurns.get(chunk.sessionId);
    if (!entry) {
      entry = {
        commandId: chunk.commandId,
        toolCount: 0,
        lastTool: '',
        lastPushAt: 0,
        tokens: [],
        tokensFetchedAt: 0,
      };
      this.liveTurns.set(chunk.sessionId, entry);
    }
    // New turn on the same session → counters restart.
    if (entry.commandId !== chunk.commandId) {
      entry.commandId = chunk.commandId;
      entry.toolCount = 0;
      entry.lastTool = '';
    }
    entry.toolCount += 1;
    const firstLine = (chunk.content ?? '').trim().split('\n')[0];
    entry.lastTool =
      firstLine || String((chunk.meta as { tool?: string } | undefined)?.tool ?? 'tool');

    const now = Date.now();
    if (now - entry.lastPushAt < PushService.LIVE_UPDATE_MIN_MS) {
      this.scheduleTrailingFlush(chunk.sessionId, entry, now);
      return;
    }
    entry.lastPushAt = now;
    void this.pushLiveActivity(chunk.sessionId, 'update', {
      state: 'running',
      toolCount: entry.toolCount,
      lastTool: entry.lastTool,
    });
  }

  /** Trailing-edge flush: a chunk suppressed by the throttle would
   *  otherwise never render — the card sits stale on the leading-edge
   *  state until the NEXT chunk happens to land outside the window (or
   *  the turn ends). Arm one timer per window that re-reads the
   *  counters at expiry and pushes whatever they say THEN. Push rate is
   *  unchanged (still ≤ 1 per window), so no extra APNs budget spend. */
  private scheduleTrailingFlush(sessionId: string, entry: LiveTurn, now: number): void {
    if (entry.pendingFlush) return;
    const delay = Math.max(0, entry.lastPushAt + PushService.LIVE_UPDATE_MIN_MS - now);
    const timer = setTimeout(() => {
      entry.pendingFlush = undefined;
      // The turn may have settled meanwhile (endLiveActivity clears the
      // timer, but guard against a same-tick race) — never revive a
      // resolved card back to "running".
      if (this.liveTurns.get(sessionId) !== entry) return;
      entry.lastPushAt = Date.now();
      void this.pushLiveActivity(sessionId, 'update', {
        state: 'running',
        toolCount: entry.toolCount,
        lastTool: entry.lastTool,
      });
    }, delay);
    timer.unref?.();
    entry.pendingFlush = timer;
  }

  /** Resolve the card when the turn settles — always immediate. */
  async endLiveActivity(sessionId: string, failed: boolean): Promise<void> {
    if (!this.enabled) return;
    const entry = this.liveTurns.get(sessionId);
    // Disarm any pending trailing flush: its "running" update firing
    // after this 'end' would flip a settled ✓/✗ card back to running.
    if (entry?.pendingFlush) {
      clearTimeout(entry.pendingFlush);
      entry.pendingFlush = undefined;
    }
    await this.pushLiveActivity(sessionId, 'end', {
      state: failed ? 'failed' : 'completed',
      toolCount: entry?.toolCount ?? 0,
      lastTool: entry?.lastTool ?? '',
    });
    this.liveTurns.delete(sessionId);
  }

  private async pushLiveActivity(
    sessionId: string,
    event: 'update' | 'end',
    contentState: { state: string; toolCount: number; lastTool: string },
  ): Promise<void> {
    try {
      const tokens = await this.liveTokens(sessionId);
      if (tokens.length === 0) return;

      const nowSeconds = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({
        aps: {
          timestamp: nowSeconds,
          event,
          'content-state': contentState,
          // Updates go stale if nothing arrives for a while (the card
          // dims); an ended card dismisses itself after a few minutes.
          ...(event === 'update'
            ? { 'stale-date': nowSeconds + 600 }
            : { 'dismissal-date': nowSeconds + 240 }),
        },
      });

      await Promise.allSettled(
        tokens.map((token) =>
          this.send(token, payload, {
            topic: this.liveActivityTopic,
            pushType: 'liveactivity',
            kind: 'live-activity',
          }),
        ),
      );
    } catch (err) {
      this.logger.warn(`live-activity push failed: ${String(err)}`);
    }
  }

  private async liveTokens(sessionId: string): Promise<string[]> {
    const entry = this.liveTurns.get(sessionId);
    const now = Date.now();
    if (entry && now - entry.tokensFetchedAt < PushService.LIVE_TOKEN_CACHE_MS) {
      return entry.tokens;
    }
    const rows = await this.prisma.liveActivityToken.findMany({
      where: { sessionId },
      select: { token: true },
    });
    const tokens = rows.map((row) => row.token);
    if (entry) {
      entry.tokens = tokens;
      entry.tokensFetchedAt = now;
    }
    return tokens;
  }

  // ── Transport ────────────────────────────────────────────────────

  private send(
    deviceToken: string,
    payload: string,
    opts: {
      topic?: string;
      pushType?: 'alert' | 'liveactivity';
      kind?: 'device' | 'live-activity';
      /** apns-collapse-id (≤64 bytes): later pushes with the same id
       *  replace the delivered notification instead of stacking. */
      collapseId?: string;
    } = {},
  ): Promise<void> {
    const topic = opts.topic ?? this.topic;
    const pushType = opts.pushType ?? 'alert';
    const kind = opts.kind ?? 'device';
    return new Promise((resolve) => {
      const session = http2.connect(this.host);
      const finish = () => {
        session.close();
        resolve();
      };
      session.on('error', (err) => {
        this.logger.warn(`APNs connect error: ${String(err)}`);
        finish();
      });

      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.providerJwt()}`,
        'apns-topic': topic,
        'apns-push-type': pushType,
        'apns-priority': '10',
        'content-type': 'application/json',
        ...(opts.collapseId ? { 'apns-collapse-id': opts.collapseId } : {}),
      });

      let status = 0;
      let body = '';
      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        if (status !== 200) {
          this.handleFailure(deviceToken, status, body, kind);
        }
        finish();
      });
      req.on('error', (err) => {
        this.logger.warn(`APNs request error: ${String(err)}`);
        finish();
      });
      req.end(payload);
    });
  }

  /** APNs feedback: dead tokens are pruned so we stop paying for them.
   *  Live-activity tokens die naturally when their activity ends — the
   *  410 here is the expected cleanup path, not an error. */
  private handleFailure(
    deviceToken: string,
    status: number,
    body: string,
    kind: 'device' | 'live-activity',
  ): void {
    let reason = '';
    try {
      reason = (JSON.parse(body) as { reason?: string }).reason ?? '';
    } catch {
      /* non-JSON error body */
    }
    this.logger.warn(`APNs ${status} ${reason} (${kind}) for token ${deviceToken.slice(0, 8)}…`);
    if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
      if (kind === 'device') {
        void this.prisma.deviceToken.delete({ where: { token: deviceToken } }).catch(() => {});
      } else {
        void this.prisma.liveActivityToken
          .delete({ where: { token: deviceToken } })
          .catch(() => {});
      }
    }
  }
}
