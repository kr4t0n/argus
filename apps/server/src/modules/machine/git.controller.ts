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
 * REST face for the right-pane git log panel, addressed by project id
 * (the (machineId, workingDir) pair). Currently exposes only the
 * recent-commits read; future endpoints (commit detail, diff) sit
 * alongside.
 */
@UseGuards(JwtAuthGuard)
@Controller('projects/:id/git')
export class ProjectGitController {
  constructor(private readonly fs: FSService) {}

  @Get('log')
  log(@Param('id') id: string, @Query() q: GitLogQueryDto): Promise<GitLogResponse> {
    return this.fs.listGitLogForProject(id, q.limit ?? GIT_LOG_DEFAULT_LIMIT);
  }
}
