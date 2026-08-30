import {
  BadRequestException,
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
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { ModelSelection } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SessionService } from './session.service';
import { CommandService } from '../command/command.service';

type AuthedRequest = Request & { user: { id: string } };

class CreateSessionDto {
  /** Project-first addressing — the machine the session runs on. */
  @IsString()
  @MinLength(1)
  machineId!: string;

  /** Project anchor; empty/absent = the machine's "no project" bucket. */
  @IsOptional()
  @IsString()
  workingDir?: string;

  @IsString()
  @MinLength(1)
  cliType!: string;

  /** Seeds Project.supportsTerminal when this create makes the row. */
  @IsOptional()
  @IsBoolean()
  supportsTerminal?: boolean;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  prompt?: string;

  /** Session-default model choice from the new-session dialog. The
   *  shape is deliberately not deep-validated — selections pass
   *  through to the CLI opaquely (free-text models are a feature). */
  @IsOptional()
  @IsObject()
  modelSelection?: ModelSelection;
}

class SetSessionModelDto {
  /** New session-default selection; null clears to "CLI default".
   *  Same pass-through validation stance as CreateSessionDto. */
  @IsOptional()
  @IsObject()
  modelSelection?: ModelSelection | null;
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

  /** Deep-link load: return a window CENTRED on this command instead of
   *  the tail. Mutually exclusive with `tailCommands` (this wins). The
   *  returned window may not reach the newest turn — see `hasMoreNewer`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  aroundCommand?: string;

  /** Turns of context to include before / after the anchor. Capped so a
   *  hand-rolled request can't ask for the whole session and undo the
   *  point of a bounded window. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  beforeCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  afterCount?: number;
}

class HistoryQueryDto {
  /** Cursor command id: return the N commands created strictly before
   *  this. Exactly one of `before` / `after` must be set. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  before?: string;

  /** Forward cursor: the N commands created strictly after this. Only
   *  meaningful for a deep-linked window that hasn't reached the newest
   *  turn yet. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  after?: string;

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

  /** Ids of files previously uploaded via POST /attachments to attach
   *  to this turn. Each must belong to the caller and be unlinked. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachmentIds?: string[];

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
    const session = await this.sessions.create(req.user.id, {
      machineId: body.machineId,
      workingDir: body.workingDir,
      cliType: body.cliType,
      supportsTerminal: body.supportsTerminal,
      title,
      modelSelection: body.modelSelection,
    });
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
    // Deep-link load takes precedence over the tail window: a caller that
    // names an anchor wants that turn on screen, not the newest one.
    if (q.aroundCommand) {
      return this.sessions.getWindowAround(
        req.user.id,
        id,
        q.aroundCommand,
        q.beforeCount ?? 5,
        q.afterCount ?? 4,
      );
    }
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
    // Exactly one direction. Accepting both would make the response shape
    // ambiguous (which cursor does `hasMore` describe?), and accepting
    // neither used to be impossible when `before` was required — now that
    // both are optional the guard has to be explicit.
    if (!!q.before === !!q.after) {
      throw new BadRequestException('pass exactly one of `before` or `after`');
    }
    const limit = q.limit ?? 20;
    return q.after
      ? this.sessions.getNewerHistory(req.user.id, id, q.after, limit)
      : this.sessions.getOlderHistory(req.user.id, id, q.before!, limit);
  }

  @Patch(':id')
  rename(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: RenameSessionDto,
  ) {
    return this.sessions.rename(req.user.id, id, body.title);
  }

  @Patch(':id/model')
  setModel(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: SetSessionModelDto,
  ) {
    return this.sessions.setModelSelection(req.user.id, id, body.modelSelection ?? null);
  }

  @Post(':id/archive')
  archive(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sessions.archive(req.user.id, id);
  }

  @Post(':id/unarchive')
  unarchive(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sessions.unarchive(req.user.id, id);
  }

  @Post(':id/seen')
  markSeen(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.sessions.markSeen(req.user.id, id);
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
    return this.commands.dispatch(req.user.id, id, body.prompt, body.options, body.attachmentIds);
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
