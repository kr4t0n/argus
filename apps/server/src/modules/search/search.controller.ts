import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SearchService } from './search.service';

type AuthedRequest = Request & { user: { id: string } };

class SearchQueryDto {
  @IsString()
  @MinLength(1)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Content search across the caller's sessions, archived included —
   * scope filtering is the client's call, not the API's.
   *
   * Lives on its own controller rather than as `GET /sessions/search`
   * because that path would sit next to `@Get(':id')` and resolve by
   * declaration order — one reordered method away from "search" being
   * read as a session id.
   */
  @Get('sessions')
  sessions(@Req() req: AuthedRequest, @Query() q: SearchQueryDto) {
    return this.search.searchSessions(req.user.id, q.q, q.limit);
  }
}
