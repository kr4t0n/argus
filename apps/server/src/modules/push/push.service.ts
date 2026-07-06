import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionDTO } from '@argus/shared-types';
import * as jwt from 'jsonwebtoken';
import * as http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../../infra/prisma/prisma.service';

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
  async notifySessionFinished(session: SessionDTO, failed: boolean): Promise<void> {
    if (!this.enabled) return;
    try {
      const devices = await this.prisma.deviceToken.findMany({
        where: { userId: session.userId },
      });
      if (devices.length === 0) return;

      // Lock-screen privacy: title is the session name, body is a
      // fixed phrase — never prompt/answer text.
      const payload = JSON.stringify({
        aps: {
          alert: {
            title: session.title,
            body: failed ? 'Turn failed' : 'Turn completed',
          },
          sound: 'default',
          'thread-id': session.id,
        },
        sessionId: session.id,
      });

      await Promise.allSettled(
        devices.map((device) => this.send(device.token, payload)),
      );
    } catch (err) {
      this.logger.warn(`push fan-out failed: ${String(err)}`);
    }
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

  private send(deviceToken: string, payload: string): Promise<void> {
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
        'apns-topic': this.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
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
          this.handleFailure(deviceToken, status, body);
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

  /** APNs feedback: dead tokens are pruned so we stop paying for them. */
  private handleFailure(deviceToken: string, status: number, body: string): void {
    let reason = '';
    try {
      reason = (JSON.parse(body) as { reason?: string }).reason ?? '';
    } catch {
      /* non-JSON error body */
    }
    this.logger.warn(`APNs ${status} ${reason} for token ${deviceToken.slice(0, 8)}…`);
    if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') {
      void this.prisma.deviceToken
        .delete({ where: { token: deviceToken } })
        .catch(() => {});
    }
  }
}
