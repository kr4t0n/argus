import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import type {
  ProjectNotesResponse,
  UserActivityResponse,
  UserExtensionsResponse,
  UserQuotaResponse,
  UserRulesResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { PROJECT_NOTES_MAX_BYTES, USER_RULES_MAX_BYTES } from '@argus/shared-types';
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

/** PUT /me/project-notes body. Same coarse char-count guard as
 *  UpdateRulesDto; the byte-level cap (PROJECT_NOTES_MAX_BYTES) is the
 *  authoritative check in the service. */
class UpdateProjectNotesDto {
  @IsString()
  @MaxLength(PROJECT_NOTES_MAX_BYTES)
  notes!: string;
}

/** PUT /me/extensions body — the full set of known extension flags. */
class UpdateExtensionsDto {
  @IsBoolean()
  notes!: boolean;

  @IsBoolean()
  progress!: boolean;
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

  @Get('quota')
  quota(@Req() req: AuthedRequest): Promise<UserQuotaResponse> {
    return this.users.quota(req.user.id);
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

  /** A project is identified by its `(machineId, workingDir)` pair —
   *  passed as query params since `workingDir` is an absolute path that
   *  doesn't belong in a path segment. Both are required. */
  @Get('project-notes')
  getProjectNotes(
    @Req() req: AuthedRequest,
    @Query('machineId') machineId: string,
    @Query('workingDir') workingDir: string,
  ): Promise<ProjectNotesResponse> {
    if (!machineId || !workingDir) {
      throw new BadRequestException('machineId and workingDir are required');
    }
    return this.users.getProjectNotes(req.user.id, machineId, workingDir);
  }

  @Put('project-notes')
  setProjectNotes(
    @Req() req: AuthedRequest,
    @Query('machineId') machineId: string,
    @Query('workingDir') workingDir: string,
    @Body() body: UpdateProjectNotesDto,
  ): Promise<ProjectNotesResponse> {
    if (!machineId || !workingDir) {
      throw new BadRequestException('machineId and workingDir are required');
    }
    return this.users.setProjectNotes(req.user.id, machineId, workingDir, body.notes);
  }

  @Get('extensions')
  getExtensions(@Req() req: AuthedRequest): Promise<UserExtensionsResponse> {
    return this.users.getExtensions(req.user.id);
  }

  @Put('extensions')
  setExtensions(
    @Req() req: AuthedRequest,
    @Body() body: UpdateExtensionsDto,
  ): Promise<UserExtensionsResponse> {
    return this.users.setExtensions(req.user.id, {
      notes: body.notes,
      progress: body.progress,
    });
  }
}
