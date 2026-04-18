import {
  Controller,
  Get,
  NotFoundException,
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
  async list(@Query() q: ListAgentsQueryDto) {
    const agents = await this.service.listAll(q.includeArchived ?? false);
    return agents.map(AgentRegistryService.toDto);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const a = await this.service.get(id);
    if (!a) throw new NotFoundException('agent not found');
    return AgentRegistryService.toDto(a);
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    const saved = await this.service.archive(id);
    return AgentRegistryService.toDto(saved);
  }

  @Post(':id/unarchive')
  async unarchive(@Param('id') id: string) {
    const saved = await this.service.unarchive(id);
    return AgentRegistryService.toDto(saved);
  }
}
