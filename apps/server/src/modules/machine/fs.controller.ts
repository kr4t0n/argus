import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import type { FSListResponse } from '@argus/shared-types';
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
    return this.service.listDir(id, q.path ?? '', q.showAll ?? false);
  }
}
