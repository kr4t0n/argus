import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';

/** DI token for the shared S3 client. */
export const S3_CLIENT = Symbol('S3_CLIENT');

/**
 * Single S3 client for the attachment store. `forcePathStyle: true` is
 * mandatory for MinIO and harmless for AWS — it keeps the bucket in the
 * URL path (`/bucket/key`) rather than the hostname, which MinIO's
 * default single-host deployment requires. The same client works against
 * AWS S3, Cloudflare R2, or any S3-compatible endpoint by swapping
 * `S3_ENDPOINT` / credentials in the env.
 */
export const S3ClientProvider: Provider = {
  provide: S3_CLIENT,
  useFactory: (config: ConfigService) =>
    new S3Client({
      endpoint: config.get<string>('S3_ENDPOINT', 'http://localhost:9000'),
      region: config.get<string>('S3_REGION', 'us-east-1'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.get<string>('S3_ACCESS_KEY', 'argus'),
        secretAccessKey: config.get<string>('S3_SECRET_KEY', 'argus-secret'),
      },
    }),
  inject: [ConfigService],
};
