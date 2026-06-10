import { Injectable, NotFoundException } from '@nestjs/common';
import type { Project } from '@prisma/client';
import type { ProjectDTO } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StreamGateway } from '../gateway/stream.gateway';

/**
 * Per-project metadata, where a "project" is the (machineId,
 * workingDir) pair the dashboard groups sessions under. Projects have
 * no first-class lifecycle — rows here are created lazily the first
 * time someone attaches metadata to the pair. Today that's just the
 * user-picked icon glyph, which follows Machine.iconKey's posture:
 * workspace-shared metadata (everyone sees the same glyph for the same
 * directory), not a per-user preference.
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StreamGateway,
  ) {}

  /** Every project row across the fleet, minus rows whose machine has
   *  been soft-deleted. The dashboard hydrates its icon map from this
   *  in one shot at boot, so no per-machine filter is offered. */
  async list(): Promise<ProjectDTO[]> {
    const rows = await this.prisma.project.findMany({
      where: { machine: { deletedAt: null } },
      orderBy: [{ machineId: 'asc' }, { workingDir: 'asc' }],
    });
    return rows.map(ProjectService.toDto);
  }

  /**
   * Persist the user's icon choice for the project and broadcast the
   * resulting ProjectDTO so every connected dashboard refreshes the
   * glyph in lockstep — same flow as MachineService.setIcon. `null`
   * means "reset to default"; the row is kept (iconKey NULL) so the
   * (machineId, workingDir) identity survives as a future metadata
   * anchor.
   */
  async setIcon(
    machineId: string,
    workingDir: string,
    iconKey: string | null,
  ): Promise<ProjectDTO> {
    const wd = workingDir.trim();
    if (!wd) throw new NotFoundException('workingDir required');
    const trimmed = typeof iconKey === 'string' ? iconKey.trim() : null;
    const next = trimmed ? trimmed : null;

    const machine = await this.prisma.machine.findUnique({
      where: { id: machineId },
      select: { id: true, deletedAt: true },
    });
    if (!machine || machine.deletedAt) throw new NotFoundException('machine not found');

    const row = await this.prisma.project.upsert({
      where: { machineId_workingDir: { machineId, workingDir: wd } },
      create: { machineId, workingDir: wd, iconKey: next },
      update: { iconKey: next },
    });
    const dto = ProjectService.toDto(row);
    this.gateway.emitProjectUpsert(dto);
    return dto;
  }

  private static toDto(row: Project): ProjectDTO {
    return {
      id: row.id,
      machineId: row.machineId,
      workingDir: row.workingDir,
      iconKey: row.iconKey ?? null,
    };
  }
}
