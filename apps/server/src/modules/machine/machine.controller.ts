import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import type { CreateAgentRequest } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MachineService } from './machine.service';
import { SidecarUpdateService } from './sidecar-update.service';

class ListMachinesQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  includeArchived?: boolean;
}

class CreateAgentDto implements CreateAgentRequest {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(80)
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  workingDir?: string;

  @IsOptional()
  @IsBoolean()
  supportsTerminal?: boolean;

  @IsOptional()
  @IsObject()
  adapter?: Record<string, unknown>;
}

@UseGuards(JwtAuthGuard)
@Controller('machines')
export class MachineController {
  constructor(
    private readonly service: MachineService,
    private readonly sidecarUpdate: SidecarUpdateService,
  ) {}

  @Get()
  list(@Query() q: ListMachinesQueryDto) {
    return this.service.listMachines(q.includeArchived ?? false);
  }

  // Bulk routes must come BEFORE the dynamic :id ones so Nest's route
  // matcher doesn't grab `sidecar` as a machine id.

  @Post('sidecar/update-all')
  @HttpCode(202)
  updateAllSidecars() {
    return this.sidecarUpdate.updateAll();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getMachine(id);
  }

  @Get(':id/agents')
  listAgents(@Param('id') id: string) {
    return this.service.listAgentsForMachine(id);
  }

  @Post(':id/agents')
  createAgent(@Param('id') id: string, @Body() body: CreateAgentDto) {
    return this.service.createAgent(id, body);
  }

  @Delete(':id/agents/:agentId')
  @HttpCode(204)
  async destroyAgent(@Param('id') id: string, @Param('agentId') agentId: string) {
    await this.service.destroyAgent(id, agentId);
  }

  @Get(':id/sidecar/version')
  getSidecarVersion(@Param('id') id: string) {
    return this.sidecarUpdate.getVersionInfo(id);
  }

  @Post(':id/sidecar/update')
  @HttpCode(202)
  updateSidecar(@Param('id') id: string) {
    return this.sidecarUpdate.updateOne(id);
  }
}
