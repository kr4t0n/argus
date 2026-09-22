import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * The APNs leg of push: raw HTTP/2 to Apple with a token-auth provider
 * JWT. Platform-agnostic trigger logic (which sessions, previews, the
 * read-sync clear) lives in `PushService`; this class only knows how to
 * deliver a payload to one APNs token and how to read Apple's feedback.
 *
 * Config (all-or-nothing; the transport is a silent no-op when unset, so
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
export class ApnsTransport {
  private readonly logger = new Logger(ApnsTransport.name);

  private readonly teamId?: string;
  private readonly keyId?: string;
  private readonly key?: string;
  readonly topic: string;
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
      this.logger.log('APNs not configured — iOS push disabled');
    }
  }

  get enabled(): boolean {
    return Boolean(this.teamId && this.keyId && this.key);
  }

  get liveActivityTopic(): string {
    return `${this.topic}.push-type.liveactivity`;
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

  send(
    deviceToken: string,
    payload: string,
    opts: {
      topic?: string;
      pushType?: 'alert' | 'liveactivity' | 'background';
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
        // Apple rejects background pushes at priority 10.
        'apns-priority': pushType === 'background' ? '5' : '10',
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
        // Keyed (token, sessionId) since Android joined; an APNs token is
        // per-activity so this still removes exactly one row.
        void this.prisma.liveActivityToken
          .deleteMany({ where: { token: deviceToken } })
          .catch(() => {});
      }
    }
  }
}
