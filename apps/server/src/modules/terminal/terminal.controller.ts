import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TerminalService } from './terminal.service';

type AuthedRequest = Request & { user: { id: string } };

class OpenTerminalDto {
  @IsOptional() @IsString() shell?: string;
  @IsOptional() @IsString() cwd?: string;
  @IsOptional() @IsInt() @Min(20) @Max(400) cols?: number;
  @IsOptional() @IsInt() @Min(5) @Max(200) rows?: number;
}

@UseGuards(JwtAuthGuard)
@Controller()
export class TerminalController {
  constructor(private readonly terminals: TerminalService) {}

  /** Project-addressed open — the runner-era route. A terminal is a
   *  (machine, cwd) pair; see TerminalService.openForProject. */
  @Post('projects/:projectId/terminals')
  async openForProject(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
    @Body() body: OpenTerminalDto,
  ) {
    return this.terminals.openForProject(req.user.id, projectId, body);
  }

  @Get('projects/:projectId/terminals')
  async listForProject(@Req() req: AuthedRequest, @Param('projectId') projectId: string) {
    const rows = await this.terminals.listForProject(req.user.id, projectId);
    return rows.map(TerminalService.toDto);
  }

  @Get('terminals/:id')
  async get(@Req() req: AuthedRequest, @Param('id') id: string) {
    const row = await this.terminals.get(req.user.id, id);
    return TerminalService.toDto(row);
  }

  @Delete('terminals/:id')
  close(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.terminals.close(req.user.id, id);
  }
}
