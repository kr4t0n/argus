import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { ModelCatalogResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ModelsService } from './models.service';

/**
 * REST face for the dashboard's model picker. Lives in
 * `agents/:id/models` (not under machines) for the same reason as the
 * FS/git endpoints — the dashboard only knows the agent id; the
 * service resolves the parent machine.
 *
 * The response is cached per agent for an hour; `?refresh=1` bypasses
 * the cache for the picker's explicit refresh affordance.
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
