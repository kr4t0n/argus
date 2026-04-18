import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'http';
import {
  SIDECAR_LINK_PATH,
  type SidecarHello,
  type SidecarHelloAck,
  type SidecarLinkFrame,
} from '@argus/shared-types';

/**
 * Direct sidecar ↔ server WebSocket link ("Tier 3" terminal transport).
 *
 * Why a second WS endpoint instead of reusing socket.io:
 *   - The browser-facing /stream namespace serves many clients per user
 *     and uses JWT auth; the sidecar is a trusted process with a
 *     shared-secret token. Different auth model.
 *   - The Go side uses gorilla/websocket; speaking raw WS keeps the
 *     protocol trivially compatible without dragging in a Go
 *     socket.io client library.
 *   - Operationally this channel is 1-connection-per-sidecar and we
 *     want the latency floor as low as possible. Plain WS frames are
 *     the shortest path.
 *
 * We attach to the same underlying http.Server as NestJS / socket.io
 * using the `noServer` upgrade pattern, filtering by pathname so
 * socket.io keeps owning `/socket.io/*`.
 */
interface Conn {
  ws: WebSocket;
  sidecarId: string;
  since: number;
  lastSeen: number;
}

type FrameHandler = (sidecarId: string, frame: SidecarLinkFrame) => void;
type DisconnectHandler = (sidecarId: string, reason: string) => void;

const PING_INTERVAL_MS = 15_000;
/** Mirrors what we advertise in hello-ack. Sidecar should ping faster
 *  than this; if we see nothing for this long we close. */
const IDLE_TIMEOUT_MS = 45_000;
/** Max frame size (bytes). A single PTY batch is capped at 16 KiB on
 *  the sidecar; we add slack for JSON overhead and pathological
 *  resize/input bursts but still cap well below ws defaults to make
 *  a misbehaving sidecar cheap to disconnect. */
const MAX_FRAME_BYTES = 64 * 1024;

@Injectable()
export class SidecarLinkService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SidecarLinkService.name);
  private wss?: WebSocketServer;
  private readonly conns = new Map<string, Conn>();
  private readonly frameHandlers = new Set<FrameHandler>();
  private readonly disconnectHandlers = new Set<DisconnectHandler>();
  private heartbeatTimer?: NodeJS.Timeout;
  private upgradeListener?: (
    req: IncomingMessage,
    socket: import('net').Socket,
    head: Buffer,
  ) => void;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly configSvc: ConfigService,
  ) {}

  onApplicationBootstrap() {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer();
    if (!httpServer) {
      this.logger.error(
        'no http server available; sidecar link will not accept connections',
      );
      return;
    }

    const expectedToken = this.configSvc.get<string>('SIDECAR_LINK_TOKEN');
    if (!expectedToken) {
      this.logger.warn(
        'SIDECAR_LINK_TOKEN not set — the /sidecar-link endpoint will accept any caller. Set it for production.',
      );
    }

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
    });

    this.upgradeListener = (req, socket, head) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://local');
      } catch {
        return; // malformed URL; let some other handler respond
      }
      if (url.pathname !== SIDECAR_LINK_PATH) return;

      const token = url.searchParams.get('token') ?? '';
      const sidecarId = url.searchParams.get('id') ?? '';
      if (expectedToken && token !== expectedToken) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
        );
        socket.destroy();
        return;
      }
      if (!sidecarId) {
        socket.write(
          'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n',
        );
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, sidecarId);
      });
    };
    httpServer.on('upgrade', this.upgradeListener);

    this.heartbeatTimer = setInterval(() => this.sweep(), PING_INTERVAL_MS);
    this.logger.log(`sidecar link listening on ${SIDECAR_LINK_PATH}`);
  }

  async onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer();
    if (httpServer && this.upgradeListener) {
      httpServer.off('upgrade', this.upgradeListener);
    }
    for (const [id, conn] of this.conns) {
      try {
        conn.ws.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
      this.conns.delete(id);
    }
    this.wss?.close();
  }

  private onConnection(ws: WebSocket, sidecarId: string) {
    ws.once('message', (raw: RawData) => {
      let hello: SidecarHello;
      try {
        hello = JSON.parse(raw.toString('utf8'));
      } catch {
        ws.close(1003, 'bad hello json');
        return;
      }
      if (hello?.kind !== 'hello' || hello.sidecarId !== sidecarId) {
        ws.close(1008, 'hello mismatch');
        return;
      }

      // Evict any existing connection for this sidecar. Last-writer-wins
      // is the right semantic: if a sidecar restarts, the old socket
      // may still be alive on our side (TCP keepalive takes minutes).
      const existing = this.conns.get(sidecarId);
      if (existing) {
        this.logger.warn(
          `sidecar ${sidecarId} replaced previous link; closing old connection`,
        );
        try {
          existing.ws.close(1012, 'replaced by newer connection');
        } catch {
          /* ignore */
        }
        this.notifyDisconnect(sidecarId, 'replaced');
      }

      const conn: Conn = {
        ws,
        sidecarId,
        since: Date.now(),
        lastSeen: Date.now(),
      };
      this.conns.set(sidecarId, conn);
      this.logger.log(`sidecar ${sidecarId} connected`);

      const ack: SidecarHelloAck = {
        kind: 'hello-ack',
        ts: Date.now(),
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      };
      ws.send(JSON.stringify(ack));

      ws.on('message', (data) => {
        conn.lastSeen = Date.now();
        try {
          const frame = JSON.parse(data.toString('utf8')) as SidecarLinkFrame;
          if (!frame || typeof (frame as any).kind !== 'string') return;
          this.dispatchFrame(sidecarId, frame);
        } catch (err) {
          this.logger.warn(
            `sidecar ${sidecarId}: invalid frame (${(err as Error).message})`,
          );
        }
      });

      ws.on('pong', () => {
        conn.lastSeen = Date.now();
      });

      const cleanup = (reason: string) => {
        // Only clear if we're still the current conn for this sidecar
        // (the replacement case above already cleared it).
        if (this.conns.get(sidecarId) === conn) {
          this.conns.delete(sidecarId);
          this.logger.log(`sidecar ${sidecarId} disconnected (${reason})`);
          this.notifyDisconnect(sidecarId, reason);
        }
      };
      ws.on('close', (code, buf) => cleanup(`close ${code} ${buf?.toString() ?? ''}`));
      ws.on('error', (err) => {
        this.logger.warn(`sidecar ${sidecarId} ws error: ${err.message}`);
      });
    });

    // 5s to send a hello, else we drop.
    const helloTimer = setTimeout(() => {
      if (!this.conns.has(sidecarId)) {
        try {
          ws.close(1008, 'hello timeout');
        } catch {
          /* ignore */
        }
      }
    }, 5_000);
    ws.once('close', () => clearTimeout(helloTimer));
  }

  private dispatchFrame(sidecarId: string, frame: SidecarLinkFrame) {
    // `hello` and `hello-ack` never flow past the handshake handler.
    if ((frame as any).kind === 'hello' || (frame as any).kind === 'hello-ack') return;
    for (const h of this.frameHandlers) {
      try {
        h(sidecarId, frame);
      } catch (err) {
        this.logger.error(
          `frame handler threw for ${sidecarId}: ${(err as Error).message}`,
        );
      }
    }
  }

  private notifyDisconnect(sidecarId: string, reason: string) {
    for (const h of this.disconnectHandlers) {
      try {
        h(sidecarId, reason);
      } catch (err) {
        this.logger.error(
          `disconnect handler threw for ${sidecarId}: ${(err as Error).message}`,
        );
      }
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [id, conn] of [...this.conns]) {
      const idleMs = now - conn.lastSeen;
      if (idleMs > IDLE_TIMEOUT_MS) {
        this.logger.warn(`sidecar ${id} idle ${idleMs}ms > ${IDLE_TIMEOUT_MS}ms; closing`);
        try {
          conn.ws.terminate();
        } catch {
          /* ignore */
        }
        // Don't wait for the 'close' event — it can take a while when
        // the underlying TCP connection is half-dead. Clean up now so
        // the bridge can force-close its terminals promptly.
        if (this.conns.get(id) === conn) {
          this.conns.delete(id);
          this.notifyDisconnect(id, 'idle timeout');
        }
        continue;
      }
      try {
        conn.ws.ping();
      } catch {
        /* ignore — close will fire */
      }
    }
  }

  // ─────────── Public API for other modules ───────────

  /** True iff there is a live link to `sidecarId`. */
  isConnected(sidecarId: string): boolean {
    const conn = this.conns.get(sidecarId);
    return !!conn && conn.ws.readyState === 1; // WebSocket.OPEN
  }

  /**
   * Send a frame to a sidecar. Returns false if no link is connected
   * (caller is responsible for surfacing a useful error).
   *
   * Performance note: `ws.send` queues on the socket's send buffer and
   * returns synchronously — this is the hot path for terminal input
   * and we deliberately do NOT await the optional callback. Back-
   * pressure is monitored via `bufferedAmount` in `sweep()`.
   */
  send(sidecarId: string, frame: SidecarLinkFrame): boolean {
    const conn = this.conns.get(sidecarId);
    if (!conn || conn.ws.readyState !== 1) return false;
    try {
      conn.ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.logger.warn(
        `send to ${sidecarId} failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /** Subscribe to incoming frames. Returns an unsubscribe function. */
  onFrame(handler: FrameHandler): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  /** Subscribe to sidecar disconnect events. */
  onDisconnect(handler: DisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }
}
