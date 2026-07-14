import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { ModelCatalogResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ModelsService } from './models.service';

/**
 * REST face for the dashboard's model picker. The agent-addressed
 * route is legacy (kept for iOS + pre-Phase-2 web); the machine
 * variant below is the Phase-2 target. Stored catalogs are
 * stale-while-revalidated; `?refresh=1` bypasses for the picker's
 * explicit refresh affordance.
 */
@UseGuards(JwtAuthGuard)
@Controller('agents/:id/models')
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  list(@Param('id') id: string, @Query('refresh') refresh?: string): Promise<ModelCatalogResponse> {
    return this.models.getCatalog(id, refresh === '1' || refresh === 'true');
  }
}

/**
 * Machine-addressed variant (Phase 2 — catalogs are machine×CLI).
 * Lets the picker fetch a catalog before any agent of the type exists
 * under the project (the auto-vivify cold-start case).
 */
@UseGuards(JwtAuthGuard)
@Controller('machines/:machineId/models')
export class MachineModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  list(
    @Param('machineId') machineId: string,
    @Query('cliType') cliType: string,
    @Query('refresh') refresh?: string,
  ): Promise<ModelCatalogResponse> {
    if (!cliType?.trim()) {
      throw new BadRequestException('cliType query parameter is required');
    }
    return this.models.getCatalogForMachine(
      machineId,
      cliType.trim(),
      refresh === '1' || refresh === 'true',
    );
  }
}
