import { Injectable, Logger } from '@nestjs/common';
import type { SessionDTO } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { ApnsTransport } from './apns.transport';
import { FcmTransport } from './fcm.transport';

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

/** A registered device, grouped by the transport that reaches it. */
type DeviceRow = { token: string; platform: string };

/**
 * Push for native clients: the platform-agnostic TRIGGER logic — which
 * sessions, the answer preview, the outstanding-banner set, the
 * read-sync clear — over two transports selected by each device row's
 * `platform`: `ApnsTransport` (iOS) and `FcmTransport` (Android). Both
 * are optional and env-gated; the service is a silent no-op with
 * neither configured, so web-only deployments need zero extra setup,
 * and a deployment with only one of them simply never reaches the
 * other platform's devices.
 *
 * Fires from the same trigger point that powers the web's desktop
 * notifications (result-ingestor flipping a session to idle/failed +
 * unread). Fire-and-forget throughout: a push failure must never affect
 * chunk ingestion.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apns: ApnsTransport,
    private readonly fcm: FcmTransport,
  ) {}

  get enabled(): boolean {
    return this.apns.enabled || this.fcm.enabled;
  }

  /** Sessions whose completion alert actually went out to some device —
   *  the banner may still be sitting on a lock screen. Consumed by the
   *  background clear so its per-chunk caller costs a Set lookup and no
   *  DB/transport work happens unless an alert was really sent. In-memory
   *  like `liveTurns`: a restart forgets outstanding banners; the apps'
   *  foreground reconcile mops those up. */
  private outstandingBanners = new Set<string>();

  /** The user's devices, keeping only rows a configured transport can
   *  reach — an Android row on an APNs-only server is skipped, not
   *  errored. */
  private async reachableDevices(userId: string): Promise<DeviceRow[]> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true, platform: true },
    });
    return rows.filter((row) =>
      row.platform === 'android' ? this.fcm.enabled : this.apns.enabled,
    );
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
      const devices = await this.reachableDevices(session.userId);
      if (devices.length === 0) return;

      // Completed turns carry a preview of the assistant's answer so
      // the banner is actionable without opening the app. NOTE this
      // puts answer text on the lock screen — users who care can scope
      // it with the OS's notification-preview setting (iOS "Show
      // Previews", Android "Sensitive notifications"). Failures keep a
      // fixed phrase (error text is stack-trace-y, not a summary).
      const body = failed
        ? 'Turn failed'
        : ((await this.answerPreview(turn)) ?? 'Turn completed');

      const apnsPayload = JSON.stringify({
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
      // The Android app renders this itself (see FcmTransport for why
      // it is a data message); `failed` lets it pick the icon/colour.
      const fcmData = {
        type: 'turn',
        sessionId: session.id,
        title: session.title,
        body,
        failed: failed ? '1' : '0',
      };

      this.outstandingBanners.add(session.id);
      await Promise.allSettled(
        devices.map((device) =>
          device.platform === 'android'
            ? this.fcm.send(device.token, fcmData, { priority: 'high' })
            : // Collapse id mirrors the web notification's `tag`: a newer
              // completion in the same session replaces the older banner
              // instead of stacking (and any duplicate send collapses too).
              // The Android app gets the same effect from the
              // notification tag it posts under.
              this.apns.send(device.token, apnsPayload, { collapseId: session.id }),
        ),
      );
    } catch (err) {
      this.logger.warn(`push fan-out failed: ${String(err)}`);
    }
  }

  /**
   * Withdraw a session's completion banner from the user's devices —
   * called wherever `unread` flips false: the session was opened on any
   * client, or a fresh turn superseded the result. The phone banner is
   * a projection of the `unread` flag.
   *
   * Neither APNs nor FCM has a server-side revoke, so this is the
   * standard workaround on both: a silent push (APNs `content-available:
   * 1` at priority 5 — Apple requires it; FCM a normal-priority data
   * message) that wakes the app to delete its own delivered
   * notification. Best-effort by design: both platforms throttle
   * background delivery and never wake a force-quit app — the clients'
   * foreground reconcile sweeps whatever slips through.
   */
  async clearSessionNotification(session: Pick<SessionDTO, 'id' | 'userId'>): Promise<void> {
    if (!this.enabled) return;
    if (!this.outstandingBanners.delete(session.id)) return;
    try {
      const devices = await this.reachableDevices(session.userId);
      if (devices.length === 0) return;
      const apnsPayload = JSON.stringify({
        aps: { 'content-available': 1 },
        clearSessionId: session.id,
      });
      const fcmData = { type: 'clear', sessionId: session.id };
      await Promise.allSettled(
        devices.map((device) =>
          device.platform === 'android'
            ? this.fcm.send(device.token, fcmData, { priority: 'normal' })
            : this.apns.send(device.token, apnsPayload, { pushType: 'background' }),
        ),
      );
    } catch (err) {
      this.logger.warn(`push clear fan-out failed: ${String(err)}`);
    }
  }

  /** Alert-body budget: the lock-screen banner shows ~4 lines and the
   *  long-look a bit more; APNs caps the whole payload at 4KB and FCM
   *  data messages at 4KB too. */
  private static readonly ALERT_BODY_MAX = 300;

  /**
   * The turn's final answer, trimmed to banner size — or null when
   * there's no usable text (caller falls back to the fixed phrase).
   *
   * claude-code's `result` final carries the canonical answer as the
   * chunk's content. codex finals are content-less (the answer streamed
   * as deltas), so reconstruct it the way the web/iOS/Android
   * transcripts do (DeltaSplit): the boundary is the highest
   * tool/stdout/stderr/error seq, and deltas strictly after it are the
   * answer. Both queries ride the (commandId, seq) index and run once
   * per finished turn, and only when the user actually has registered
   * devices.
   *
   * Port-sync note: the client DeltaSplits additionally EXCLUDE
   * sub-agent-nested chunks (meta.parentToolUseId) and treat earlier
   * inner-turn finals as boundaries (multi-final async commands). Both
   * refinements are deliberately omitted here: this reconstruction path
   * only runs for content-less finals (codex), and codex has no
   * sub-agents and emits one final per command — claude turns always
   * take the finalContent shortcut above. Revisit if either invariant
   * changes.
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

  // ── Live Activities (APNs only today) ────────────────────────────
  //
  // The iOS client starts an ActivityKit activity for a running turn
  // and registers its per-activity push token against the session.
  // While the app is backgrounded, WE are the only thing that can move
  // the lock-screen card: throttled 'update' events as tool chunks
  // stream, and an immediate 'end' when the turn settles. The Swift
  // ContentState is `{state, toolCount, lastTool}` — key names here
  // must match it EXACTLY (ActivityKit decodes content-state with the
  // struct's Codable). Android Live Updates (Phase 6 of the Android
  // plan) will ride the same throttle as FCM data messages.

  /** Per-session live-turn bookkeeping: tool counters + push throttle +
   *  a short token-existence cache so chunk ingestion never queries
   *  Postgres more than once per window. */
  private liveTurns = new Map<string, LiveTurn>();

  private static readonly LIVE_UPDATE_MIN_MS = 15_000;
  private static readonly LIVE_TOKEN_CACHE_MS = 60_000;

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
    if (!this.apns.enabled) return;
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
    if (!this.apns.enabled) return;
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
          this.apns.send(token, payload, {
            topic: this.apns.liveActivityTopic,
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
}
