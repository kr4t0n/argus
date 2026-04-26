import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SessionService } from './session.service';
import { CommandService } from '../command/command.service';

type AuthedRequest = Request & { user: { id: string } };

class CreateSessionDto {
  @IsString()
  @MinLength(1)
  agentId!: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  prompt?: string;
}

class RenameSessionDto {
  @IsString()
  @MinLength(1)
  title!: string;
}

class ChunkQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq?: number;

  /** Page size for the initial load — only return the last N commands
   *  (and their chunks) instead of the full session history. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  tailCommands?: number;
}

class HistoryQueryDto {
  /** Cursor command id: return the N commands created strictly before this. */
  @IsString()
  @MinLength(1)
  before!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

class ListSessionsQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeArchived?: boolean;
}

class CreateCommandDto {
  @IsString()
  @MinLength(1)
  prompt!: string;

  @IsOptional()
  options?: Record<string, unknown>;
}

class ForkSessionDto {
  @IsString()
  @MinLength(1)
  commandId!: string;

  @IsOptional()
  @IsString()
  title?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly commands: CommandService,
  ) {}

  @Get()
  list(@Req() req: AuthedRequest, @Query() q: ListSessionsQueryDto) {
    return this.sessions.list(req.user.id, q.includeArchived ?? false);
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: CreateSessionDto) {
    const title = body.title ?? body.prompt?.slice(0, 60) ?? 'New session';
    const session = await this.sessions.create(req.user.id, body.agentId, title);
    let command = null;
    if (body.prompt) {
      command = await this.commands.dispatch(req.user.id, session.id, body.prompt);
    }
    return { session, command };
  }

  @Get(':id')
  async get(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query() q: ChunkQueryDto,
  ) {
    return this.sessions.getWithChunks(
      req.user.id,
      id,
      q.afterSeq ?? 0,
      q.tailCommands,
    );
  }

  @Get(':id/chunks')
  async chunks(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query() q: ChunkQueryDto,
  ) {
    const { chunks, commands } = await this.sessions.getWithChunks(
      req.user.id,
      id,
      q.afterSeq ?? 0,
    );
    return { commands, chunks };
  }

  @Get(':id/history')
  async history(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Query() q: HistoryQueryDto,
  ) {
    return this.sessions.getOlderHistory(
      req.user.id,
      id,
      q.before,
      q.limit ?? 20,
    );
  }

  @Patch(':id')
  rename(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: RenameSessionDto,
  ) {
    return this.sessions.rename(req.user.id, id, body.title);
  }

  @Post(':id/archive')
  archive(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sessions.archive(req.user.id, id);
  }

  @Post(':id/unarchive')
  unarchive(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sessions.unarchive(req.user.id, id);
  }

  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.sessions.remove(req.user.id, id);
    return { ok: true };
  }

  @Post(':id/commands')
  async createCommand(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: CreateCommandDto,
  ) {
    return this.commands.dispatch(req.user.id, id, body.prompt, body.options);
  }

  @Post(':id/fork')
  async fork(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ForkSessionDto,
  ) {
    return this.sessions.fork(req.user.id, id, body.commandId, body.title);
  }
}
