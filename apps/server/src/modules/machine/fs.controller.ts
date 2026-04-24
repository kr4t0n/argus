import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { FSListResponse, FSReadResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FSService } from './fs.service';

class FSListQueryDto {
  /** Path relative to the agent's workingDir. Empty / "." means root. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  path?: string;

  /** When true, include gitignored entries and don't filter dotfiles.
   *  `.git` is still hidden — rendering it only adds noise. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  showAll?: boolean;

  /** How many directory levels to include in the response (1 = just
   *  the requested path, the historical behavior). Higher values let
   *  the dashboard prefetch multiple levels in a single round trip so
   *  expanding cached folders is instant. The sidecar applies a
   *  descent budget that stops the BFS from going deeper once enough
   *  entries have been collected — individual directory listings are
   *  not truncated. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  depth?: number;
}

class FSReadQueryDto {
  /** Path relative to the agent's workingDir. Required (unlike list,
   *  there's no "read root" semantic). */
  @IsString()
  @MaxLength(2048)
  path!: string;
}

/**
 * Thin REST face over FSService. Lives in `agents/:id/fs/*` rather
 * than `machines/:id/...` because the client only knows the agent id
 * — the service resolves the parent machine on the fly.
 */
@UseGuards(JwtAuthGuard)
@Controller('agents/:id/fs')
export class FSController {
  constructor(private readonly service: FSService) {}

  @Get('list')
  list(@Param('id') id: string, @Query() q: FSListQueryDto): Promise<FSListResponse> {
    return this.service.listDir(id, q.path ?? '', q.showAll ?? false, q.depth ?? 1);
  }

  @Get('read')
  read(@Param('id') id: string, @Query() q: FSReadQueryDto): Promise<FSReadResponse> {
    return this.service.readFile(id, q.path);
  }
}
