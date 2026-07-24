import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';

/** DI token for the shared S3 client. `null` when the object store is not
 *  configured — see the factory below. */
export const S3_CLIENT = Symbol('S3_CLIENT');

/**
 * Single S3 client for the attachment store, or `null` when `S3_ENDPOINT`
 * is unset — attachments are an OPTIONAL feature (the Helm chart ships
 * with `objectStore.endpoint: ""` and deploys no bucket), and the service
 * turns a null client into a clean 503 instead of a connection error.
 * Never default to a localhost endpoint: inside a server container that
 * points the client at its own loopback, and every upload dies with an
 * opaque `AggregateError` from Node's connect path.
 *
 * `forcePathStyle: true` is mandatory for MinIO and harmless for AWS — it
 * keeps the bucket in the URL path (`/bucket/key`) rather than the
 * hostname, which MinIO's default single-host deployment requires. The
 * same client works against AWS S3, Cloudflare R2, or any S3-compatible
 * endpoint by swapping `S3_ENDPOINT` / credentials in the env.
 *
 * The explicit `connectionTimeout` matters for the same reason: the SDK
 * default is no connect deadline at all, so a black-holed endpoint (a
 * dropped-packet firewall rather than a refused connection) would hang
 * the upload request until the client gives up on its own.
 */
export const S3ClientProvider: Provider = {
  provide: S3_CLIENT,
  useFactory: (config: ConfigService): S3Client | null => {
    const logger = new Logger('S3Client');
    const endpoint = config.get<string>('S3_ENDPOINT', '').trim();
    if (!endpoint) {
      logger.warn('S3_ENDPOINT is not set — file attachments are disabled');
      return null;
    }
    return new S3Client({
      endpoint,
      region: config.get<string>('S3_REGION', 'us-east-1'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.get<string>('S3_ACCESS_KEY', 'argus'),
        secretAccessKey: config.get<string>('S3_SECRET_KEY', 'argus-secret'),
      },
      // Connect deadline only — deliberately no `requestTimeout`, which in
      // @smithy/node-http-handler is warn-only unless you also pass
      // `throwOnRequestTimeout` and would just spam the log on a legitimately
      // slow transfer (a sidecar pulling a 25 MiB file over a thin link).
      requestHandler: { connectionTimeout: 5_000 },
    });
  },
  inject: [ConfigService],
};
