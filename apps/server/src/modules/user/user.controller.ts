import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { UserActivityResponse, UserUsageResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserService } from './user.service';

type AuthedRequest = Request & { user: { id: string } };

/**
 * Per-user views for the dashboard's `/user` page. Currently exposes
 * the activity grid + lifetime token totals; future endpoints
 * (per-day session digest, per-agent usage breakdown) would sit
 * alongside under the same `/me` prefix.
 */
@UseGuards(JwtAuthGuard)
@Controller('me')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get('activity')
  activity(@Req() req: AuthedRequest): Promise<UserActivityResponse> {
    return this.users.activity(req.user.id);
  }

  @Get('usage')
  usage(@Req() req: AuthedRequest): Promise<UserUsageResponse> {
    return this.users.usage(req.user.id);
  }
}
