import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { ModelCatalogResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ModelsService } from './models.service';

/**
 * REST face for the dashboard's model picker. Catalogs are machine×CLI
 * (a property of the installed binary), so the picker can fetch one
 * before any session of that type exists. Stored catalogs are
 * stale-while-revalidated; `?refresh=1` bypasses for the picker's
 * explicit refresh affordance.
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
