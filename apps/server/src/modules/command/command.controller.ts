import { Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CommandService } from './command.service';

type AuthedRequest = Request & { user: { id: string } };

@UseGuards(JwtAuthGuard)
@Controller('commands')
export class CommandController {
  constructor(private readonly commands: CommandService) {}

  @Post(':id/cancel')
  cancel(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.commands.cancel(req.user.id, id);
  }
}
