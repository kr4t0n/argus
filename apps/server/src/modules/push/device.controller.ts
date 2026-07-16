import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type { DeviceDTO, LiveActivityDTO } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { PushService } from './push.service';

type AuthedRequest = Request & { user: { id: string } };

/** POST /me/devices body. APNs tokens are hex; keep the check loose
 *  enough for future platforms but tight enough to bounce garbage. */
class RegisterDeviceDto {
  @IsString()
  @MaxLength(256)
  @Matches(/^[0-9a-fA-F]+$/)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;
}

/** POST /me/live-activities body — an ActivityKit per-activity push
 *  token bound to the session whose turn the activity tracks. */
class RegisterLiveActivityDto {
  @IsString()
  @MaxLength(256)
  @Matches(/^[0-9a-fA-F]+$/)
  token!: string;

  @IsString()
  @MaxLength(64)
  sessionId!: string;
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
    const row = await this.prisma.deviceToken.upsert({
      where: { token: body.token },
      create: {
        userId: req.user.id,
        token: body.token,
        platform: body.platform ?? 'ios',
      },
      update: {
        userId: req.user.id,
        platform: body.platform ?? 'ios',
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
 * ActivityKit push-token registry. Per-activity tokens: the iOS client
 * registers one when it puts a turn on the lock screen and deletes it
 * when the activity ends (APNs 410 feedback prunes anything missed).
 * Registration invalidates the push service's per-session token cache
 * so a fresh activity gets its first update promptly.
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
    const row = await this.prisma.liveActivityToken.upsert({
      where: { token: body.token },
      create: { userId: req.user.id, sessionId: body.sessionId, token: body.token },
      update: { userId: req.user.id, sessionId: body.sessionId },
    });
    this.push.invalidateLiveTokens(body.sessionId);
    return {
      id: row.id,
      token: row.token,
      sessionId: row.sessionId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  @Delete(':token')
  @HttpCode(204)
  async unregister(@Req() req: AuthedRequest, @Param('token') token: string): Promise<void> {
    const row = await this.prisma.liveActivityToken.findUnique({ where: { token } });
    await this.prisma.liveActivityToken
      .deleteMany({ where: { token, userId: req.user.id } })
      .catch(() => {});
    if (row) this.push.invalidateLiveTokens(row.sessionId);
  }
}
