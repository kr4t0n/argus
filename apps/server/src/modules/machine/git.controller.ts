import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { GIT_LOG_DEFAULT_LIMIT, GIT_LOG_MAX_LIMIT, type GitLogResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FSService } from './fs.service';

class GitLogQueryDto {
  /** How many recent commits to return. Defaults to 50, capped at 200
   *  by the controller and again by the sidecar. The bounds are tight
   *  enough that pagination isn't required for v1. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GIT_LOG_MAX_LIMIT)
  limit?: number;
}

/**
 * REST face for the right-pane git log panel. Lives in
 * `agents/:id/git/*` rather than `machines/:id/git/*` for the same
 * reason as the FS endpoints — the dashboard only knows the agent id,
 * the service resolves the parent machine. Currently exposes only the
 * recent-commits read; future endpoints (commit detail, diff) would
 * sit alongside.
 */
@UseGuards(JwtAuthGuard)
@Controller('agents/:id/git')
export class GitController {
  constructor(private readonly fs: FSService) {}

  @Get('log')
  log(@Param('id') id: string, @Query() q: GitLogQueryDto): Promise<GitLogResponse> {
    return this.fs.listGitLog(id, q.limit ?? GIT_LOG_DEFAULT_LIMIT);
  }
}
