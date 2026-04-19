import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentRegistryService } from './agent-registry.service';

class ListAgentsQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeArchived?: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('agents')
export class AgentRegistryController {
  constructor(private readonly service: AgentRegistryService) {}

  @Get()
  list(@Query() q: ListAgentsQueryDto) {
    return this.service.listAll(q.includeArchived ?? false);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.service.archive(id);
  }

  @Post(':id/unarchive')
  unarchive(@Param('id') id: string) {
    return this.service.unarchive(id);
  }
}
