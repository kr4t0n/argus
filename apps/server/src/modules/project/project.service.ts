import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Project } from '@prisma/client';
import type { ProjectDTO } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { MachineService } from '../machine/machine.service';

/**
 * First-class "project" rows — the (machineId, workingDir) pair the
 * dashboard groups sessions under (Phase 1/1b of
 * docs/plan-agent-to-runners.md). Rows are created two ways: lazily by
 * metadata attachment (icon picks, session creation pinning
 * `Session.projectId`) and explicitly by the sidebar's create-project
 * flow, which promotes what used to be a client-only localStorage
 * placeholder. All metadata here is workspace-shared (everyone sees
 * the same label/glyph for the same directory), not per-user.
 *
 * Archive state lives here, but the archive *cascade* (flipping the
 * project's sessions/agents) stays client-driven through the existing
 * per-item REST endpoints — the row just persists the outcome plus the
 * restore snapshot, so archives survive browser switches.
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StreamGateway,
    private readonly machines: MachineService,
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

  /**
   * Create (or reclaim) a project placeholder. Upsert by the
   * (machineId, workingDir) identity: the row may already exist from
   * an icon pick or a session pin, and re-creating an archived project
   * deliberately un-archives it — the popover's restore-via-recreate
   * flow depends on that (matches the old localStorage add()
   * semantics).
   */
  async create(input: {
    machineId: string;
    workingDir: string;
    name?: string;
    supportsTerminal?: boolean;
  }): Promise<ProjectDTO> {
    const wd = input.workingDir.trim();
    if (!wd) throw new BadRequestException('workingDir is required');
    const machine = await this.prisma.machine.findUnique({
      where: { id: input.machineId },
      select: { id: true, deletedAt: true },
    });
    if (!machine || machine.deletedAt) throw new NotFoundException('machine not found');

    const name = input.name?.trim() || null;
    const row = await this.prisma.project.upsert({
      where: { machineId_workingDir: { machineId: input.machineId, workingDir: wd } },
      create: {
        machineId: input.machineId,
        workingDir: wd,
        name,
        supportsTerminal: input.supportsTerminal ?? false,
      },
      update: {
        // Only overwrite the label when the caller supplied one — a
        // bare re-create must not blank a name picked earlier.
        ...(name ? { name } : {}),
        ...(input.supportsTerminal !== undefined
          ? { supportsTerminal: input.supportsTerminal }
          : {}),
        archivedAt: null,
        archiveSnapshot: Prisma.DbNull,
      },
    });
    const dto = ProjectService.toDto(row);
    this.gateway.emitProjectUpsert(dto);
    // Same rule as session-create vivify: the sidecar's fs/git
    // allowlist only learns new projects via a sync-projects push, so
    // re-push on explicit creation too (idempotent snapshot; failure
    // heals at the next registration).
    try {
      await this.machines.syncProjects(input.machineId);
    } catch {
      /* register-time sync heals */
    }
    return dto;
  }

  async rename(id: string, name: string): Promise<ProjectDTO> {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('name is required');
    const row = await this.prisma.project
      .update({ where: { id }, data: { name: trimmed } })
      .catch(() => null);
    if (!row) throw new NotFoundException('project not found');
    const dto = ProjectService.toDto(row);
    this.gateway.emitProjectUpsert(dto);
    return dto;
  }

  /**
   * Persist the outcome of a client-side archive cascade. `snapshot`
   * carries the ids the cascade actually flipped; omitted for legacy
   * broad archives (restore then falls back to un-archiving
   * everything under the project, same as the pre-promotion web
   * behavior).
   */
  async archive(
    id: string,
    snapshot?: { archivedAgentIds: string[]; archivedSessionIds: string[] },
  ): Promise<ProjectDTO> {
    const row = await this.prisma.project
      .update({
        where: { id },
        data: {
          archivedAt: new Date(),
          archiveSnapshot: snapshot
            ? (snapshot as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      })
      .catch(() => null);
    if (!row) throw new NotFoundException('project not found');
    const dto = ProjectService.toDto(row);
    this.gateway.emitProjectUpsert(dto);
    return dto;
  }

  /** Clear archive state. The snapshot is only meaningful while
   *  archived — clearing it keeps a later re-archive from consulting
   *  a stale snapshot (mirrors the old store semantics). */
  async unarchive(id: string): Promise<ProjectDTO> {
    const row = await this.prisma.project
      .update({
        where: { id },
        data: { archivedAt: null, archiveSnapshot: Prisma.DbNull },
      })
      .catch(() => null);
    if (!row) throw new NotFoundException('project not found');
    const dto = ProjectService.toDto(row);
    this.gateway.emitProjectUpsert(dto);
    return dto;
  }

  private static toDto(row: Project): ProjectDTO {
    return {
      id: row.id,
      machineId: row.machineId,
      workingDir: row.workingDir,
      name: row.name ?? null,
      supportsTerminal: row.supportsTerminal,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      archiveSnapshot:
        (row.archiveSnapshot as ProjectDTO['archiveSnapshot']) ?? null,
      iconKey: row.iconKey ?? null,
    };
  }
}
