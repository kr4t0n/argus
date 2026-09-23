import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PushConfigDTO } from '@argus/shared-types';
import * as jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** The fields of a Firebase service-account JSON the transport uses. */
type ServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

/**
 * The FCM leg of push — Firebase Cloud Messaging HTTP v1 for the native
 * Android client. Same posture as `ApnsTransport`: optional, env-gated,
 * silent when unset.
 *
 * Config:
 *   FCM_SERVICE_ACCOUNT_BASE64  the service-account JSON, base64-encoded
 *   FCM_SERVICE_ACCOUNT_PATH    …or a path to the JSON (BASE64 wins)
 *   FCM_PROJECT_ID              Firebase project id; defaults to the
 *                               service account's `project_id`
 * and, for the client (see `PushConfigController`):
 *   FCM_APP_ID       the Android app's Firebase application id
 *                    (`1:<sender>:android:<hash>` in google-services.json)
 *   FCM_API_KEY      the Firebase Android API key (a public identifier)
 *   FCM_SENDER_ID    the project number
 *
 * Two design points specific to a self-hosted product:
 *
 * **One APK for any server.** Firebase is normally configured at build
 * time from `google-services.json`, which would bind the binary to one
 * operator's Firebase project. Instead the server exposes its PUBLIC
 * client identifiers (`GET /me/push/config`) and the app initialises
 * Firebase at runtime from them; the secret (the service account) never
 * leaves the server.
 *
 * **Every message is a data message.** A "notification" message is
 * rendered by the system tray when the app is backgrounded and only
 * reaches the app's code in the foreground, which breaks three things
 * the iOS client has: on-screen suppression (never nag about the session
 * being read), tag-replacement of an older banner in the same session,
 * and the read-sync clear. Data messages reach the app's messaging
 * service in every state short of force-stop, and the app renders the
 * notification itself. Alerts go at HIGH priority (they produce a
 * visible notification, which is what FCM's high-priority budget is
 * for); clears at NORMAL.
 *
 * Auth is an OAuth2 access token minted from the service account (RS256
 * JWT assertion → token endpoint), cached until shortly before expiry.
 * Transport is Node's global fetch — HTTP v1 is plain HTTPS/JSON.
 */
@Injectable()
export class FcmTransport {
  private readonly logger = new Logger(FcmTransport.name);

  private readonly projectId?: string;
  private readonly clientEmail?: string;
  private readonly privateKey?: string;
  /** Public client identifiers, or null when any is missing. */
  readonly clientConfig: PushConfigDTO | null;

  private cachedAccessToken?: { token: string; expiresAt: number };
  private accessTokenInFlight?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const account = FcmTransport.readServiceAccount(config, this.logger);
    this.projectId = config.get<string>('FCM_PROJECT_ID') || account?.project_id;
    this.clientEmail = account?.client_email;
    this.privateKey = account?.private_key;

    const appId = config.get<string>('FCM_APP_ID');
    const apiKey = config.get<string>('FCM_API_KEY');
    const senderId = config.get<string>('FCM_SENDER_ID');
    this.clientConfig =
      this.projectId && appId && apiKey && senderId
        ? { projectId: this.projectId, applicationId: appId, apiKey, senderId }
        : null;

    if (this.enabled) {
      this.logger.log(
        `FCM enabled (project ${this.projectId}${this.clientConfig ? '' : '; client config incomplete — Android devices cannot register'})`,
      );
    } else {
      this.logger.log('FCM not configured — Android push disabled');
    }
  }

  private static readServiceAccount(
    config: ConfigService,
    logger: Logger,
  ): ServiceAccount | undefined {
    const base64 = config.get<string>('FCM_SERVICE_ACCOUNT_BASE64');
    const path = config.get<string>('FCM_SERVICE_ACCOUNT_PATH');
    try {
      const raw = base64
        ? Buffer.from(base64, 'base64').toString('utf8')
        : path
          ? readFileSync(path, 'utf8')
          : undefined;
      return raw ? (JSON.parse(raw) as ServiceAccount) : undefined;
    } catch (err) {
      logger.error(`failed to read FCM service account: ${String(err)}`);
      return undefined;
    }
  }

  /** Sending is possible: a project id plus a service account to sign with. */
  get enabled(): boolean {
    return Boolean(this.projectId && this.clientEmail && this.privateKey);
  }

  /**
   * Deliver one data message. `data` values must be strings (FCM
   * rejects anything else). Never throws — failures are logged, and
   * dead-token feedback prunes the device row.
   */
  async send(
    deviceToken: string,
    data: Record<string, string>,
    opts: { priority: 'high' | 'normal'; kind?: 'device' | 'live-activity' } = {
      priority: 'high',
    },
  ): Promise<void> {
    const kind = opts.kind ?? 'device';
    try {
      const accessToken = await this.accessToken();
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId!)}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              data,
              android: {
                priority: opts.priority === 'high' ? 'HIGH' : 'NORMAL',
                // A completion alert that cannot be delivered within the
                // hour is stale (the user will have looked by then); a
                // clear is only useful while the banner is still up.
                ttl: opts.priority === 'high' ? '3600s' : '600s',
              },
            },
          }),
        },
      );
      if (!response.ok) {
        this.handleFailure(deviceToken, response.status, await response.text(), kind);
      }
    } catch (err) {
      this.logger.warn(`FCM request error: ${String(err)}`);
    }
  }

  /**
   * FCM feedback. `UNREGISTERED` (404) is the token's owner having
   * uninstalled or reset the app — prune, as APNs 410 does. A 400
   * `INVALID_ARGUMENT` is pruned only when Google's message names the
   * registration token: the same code also covers a malformed payload,
   * and pruning every device over a server-side bug would be the wrong
   * kind of self-healing. A dead token is dead for every purpose, so a
   * live-activity failure prunes every session row under it.
   */
  private handleFailure(
    deviceToken: string,
    status: number,
    body: string,
    kind: 'device' | 'live-activity',
  ): void {
    let code = '';
    let message = '';
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; details?: Array<{ errorCode?: string }> };
      };
      message = parsed.error?.message ?? '';
      code = parsed.error?.details?.find((d) => d.errorCode)?.errorCode ?? '';
    } catch {
      /* non-JSON error body */
    }
    this.logger.warn(
      `FCM ${status} ${code || message} (${kind}) for token ${deviceToken.slice(0, 8)}…`,
    );
    const invalidToken =
      code === 'INVALID_ARGUMENT' && /registration token/i.test(message);
    if (code === 'UNREGISTERED' || status === 404 || invalidToken) {
      if (kind === 'device') {
        void this.prisma.deviceToken.delete({ where: { token: deviceToken } }).catch(() => {});
      } else {
        void this.prisma.liveActivityToken
          .deleteMany({ where: { token: deviceToken } })
          .catch(() => {});
      }
    }
  }

  /** OAuth2 access token for the messaging scope, cached until a minute
   *  before it expires; concurrent callers share one mint. */
  private accessToken(): Promise<string> {
    const cached = this.cachedAccessToken;
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.token);
    if (this.accessTokenInFlight) return this.accessTokenInFlight;
    this.accessTokenInFlight = this.mintAccessToken().finally(() => {
      this.accessTokenInFlight = undefined;
    });
    return this.accessTokenInFlight;
  }

  private async mintAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: this.clientEmail!,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      this.privateKey!,
      { algorithm: 'RS256' },
    );
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`token endpoint ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('token endpoint returned no access_token');
    const ttlMs = Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
    this.cachedAccessToken = { token: body.access_token, expiresAt: Date.now() + ttlMs };
    return body.access_token;
  }
}
