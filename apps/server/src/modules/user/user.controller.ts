import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type {
  UserActivityResponse,
  UserRulesResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { USER_RULES_MAX_BYTES } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserService } from './user.service';

type AuthedRequest = Request & { user: { id: string } };

/** PUT /me/rules body. The byte-level cap is enforced server-side
 *  (USER_RULES_MAX_BYTES) so multi-byte UTF-8 chars count correctly;
 *  this @MaxLength is a coarser char-count guard that bounces
 *  obviously-too-large payloads before they hit the byte check. */
class UpdateRulesDto {
  @IsString()
  @MaxLength(USER_RULES_MAX_BYTES)
  rules!: string;
}

/**
 * Per-user views for the dashboard's `/user` page. Currently exposes
 * the activity grid, lifetime token totals, and editable per-user
 * rules (free-form coding-agent guidance); future endpoints
 * (per-agent usage breakdown, per-day session digest) would sit
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

  @Get('rules')
  getRules(@Req() req: AuthedRequest): Promise<UserRulesResponse> {
    return this.users.getRules(req.user.id);
  }

  @Put('rules')
  setRules(
    @Req() req: AuthedRequest,
    @Body() body: UpdateRulesDto,
  ): Promise<UserRulesResponse> {
    return this.users.setRules(req.user.id, body.rules);
  }
}
