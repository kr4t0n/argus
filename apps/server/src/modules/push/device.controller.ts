import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { DeviceDTO, LiveActivityDTO } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PushService } from './push.service';

type AuthedRequest = Request & { user: { id: string } };

/** POST /me/devices body. The token's shape depends on the platform —
 *  APNs tokens are hex, FCM registration tokens are base64url plus a
 *  colon — so the class-level check only bounds length and the
 *  alphabet is validated per platform in the handler. */
class RegisterDeviceDto {
  @IsString()
  @MaxLength(1024)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;
}

/** Per-platform token alphabets. `ios` is the APNs hex the DTO used to
 *  require globally; `android` is the FCM registration-token alphabet
 *  (base64url characters and one colon after the instance-id prefix),
 *  bounded generously — Google documents no fixed length. */
const TOKEN_SHAPES: Record<string, RegExp> = {
  ios: /^[0-9a-fA-F]{1,256}$/,
  android: /^[A-Za-z0-9_:\-]{20,1024}$/,
};

/** POST /me/live-activities body — on iOS an ActivityKit per-activity
 *  push token, on Android (`platform: "android"`) the device's FCM
 *  registration token, either bound to the session whose turn the
 *  lock-screen card tracks. Token shape is validated per platform in
 *  the handler, as for devices. */
class RegisterLiveActivityDto {
  @IsString()
  @MaxLength(1024)
  token!: string;

  @IsString()
  @MaxLength(64)
  sessionId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;
}

/**
 * Push-device registry for native clients. Registration is idempotent
 * (same token re-posts refresh `lastSeenAt`); a token that moved to a
 * different account is re-homed — a device has exactly one owner, and
 * the previous owner must stop receiving someone else's session alerts.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/devices')
export class DeviceController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async register(@Req() req: AuthedRequest, @Body() body: RegisterDeviceDto): Promise<DeviceDTO> {
    const platform = body.platform ?? 'ios';
    const shape = TOKEN_SHAPES[platform];
    if (!shape) throw new BadRequestException(`unknown push platform "${platform}"`);
    if (!shape.test(body.token)) {
      throw new BadRequestException(`token is not a valid ${platform} push token`);
    }
    const row = await this.prisma.deviceToken.upsert({
      where: { token: body.token },
      create: {
        userId: req.user.id,
        token: body.token,
        platform,
      },
      update: {
        userId: req.user.id,
        platform,
        lastSeenAt: new Date(),
      },
    });
    return {
      id: row.id,
      token: row.token,
      platform: row.platform,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Idempotent: deleting an unknown (or foreign) token is a no-op 204,
   *  so logout can fire-and-forget. */
  @Delete(':token')
  @HttpCode(204)
  async unregister(@Req() req: AuthedRequest, @Param('token') token: string): Promise<void> {
    await this.prisma.deviceToken
      .deleteMany({ where: { token, userId: req.user.id } })
      .catch(() => {});
  }
}

/**
 * Live-turn token registry. iOS registers a per-activity ActivityKit
 * token when it puts a turn on the lock screen; Android registers its
 * FCM device token per session for a Live Update. Both delete on end
 * (push feedback prunes anything missed). Rows are keyed by
 * (token, sessionId): an Android device tracking two turns has two
 * rows under one token. Registration invalidates the push service's
 * per-session token cache so a fresh activity gets its first update
 * promptly.
 */
@UseGuards(JwtAuthGuard)
@Controller('me/live-activities')
export class LiveActivityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  @Post()
  async register(
    @Req() req: AuthedRequest,
    @Body() body: RegisterLiveActivityDto,
  ): Promise<LiveActivityDTO> {
    const platform = body.platform ?? 'ios';
    const shape = TOKEN_SHAPES[platform];
    if (!shape) throw new BadRequestException(`unknown push platform "${platform}"`);
    if (!shape.test(body.token)) {
      throw new BadRequestException(`token is not a valid ${platform} push token`);
    }
    const row = await this.prisma.liveActivityToken.upsert({
      where: { token_sessionId: { token: body.token, sessionId: body.sessionId } },
      create: { userId: req.user.id, sessionId: body.sessionId, token: body.token, platform },
      update: { userId: req.user.id, platform },
    });
    this.push.invalidateLiveTokens(body.sessionId);
    return {
      id: row.id,
      token: row.token,
      sessionId: row.sessionId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Without `?sessionId=` every registration under the token goes (the
   *  iOS shape — one activity, one token); with it, only that session's
   *  row, so an Android device ending one turn keeps tracking the rest. */
  @Delete(':token')
  @HttpCode(204)
  async unregister(
    @Req() req: AuthedRequest,
    @Param('token') token: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<void> {
    const where = { token, userId: req.user.id, ...(sessionId ? { sessionId } : {}) };
    const rows = await this.prisma.liveActivityToken.findMany({
      where,
      select: { sessionId: true },
    });
    await this.prisma.liveActivityToken.deleteMany({ where }).catch(() => {});
    for (const row of rows) this.push.invalidateLiveTokens(row.sessionId);
  }
}
