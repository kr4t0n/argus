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
import type { DeviceDTO } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../../infra/prisma/prisma.service';

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
