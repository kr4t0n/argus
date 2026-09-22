import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import type { PushConfigDTO } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FcmTransport } from './fcm.transport';

/**
 * `GET /me/push/config` — the PUBLIC Firebase client identifiers the
 * Android app needs to initialise Firebase at runtime (one APK for any
 * server; see `FcmTransport`). 404 when the server has no FCM client
 * config, which the app reads as "this server has no Android push" and
 * surfaces on its notifications toggle. The values are the same ones a
 * `google-services.json` ships inside every APK built against the
 * project — identifiers, not secrets — but the endpoint is still
 * JWT-guarded so an unauthenticated caller learns nothing about the
 * deployment.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/push')
export class PushConfigController {
  constructor(private readonly fcm: FcmTransport) {}

  @Get('config')
  config(): PushConfigDTO {
    const config = this.fcm.clientConfig;
    if (!config) throw new NotFoundException('push is not configured on this server');
    return config;
  }
}
