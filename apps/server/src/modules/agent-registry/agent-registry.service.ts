import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Agent as PAgent } from '@prisma/client';
import type { AgentDTO } from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { MachineService } from '../machine/machine.service';

/**
 * Agent CRUD that the dashboard's per-agent endpoints hit (list, get,
 * archive, unarchive).
 *
 * The lifecycle stream consumer used to live here too, but it now lives
 * in MachineService — agents are children of machines and the two share
 * the same Redis stream. This service stays small and is purely the
 * REST/DB face of the per-agent surface.
 */
@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: StreamGateway,
  ) {}

  async listAll(includeArchived = false): Promise<AgentDTO[]> {
    const rows = await this.prisma.agent.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      include: { machine: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { type: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => MachineService.agentToDto(r, r.machine.name));
  }

  async get(id: string): Promise<AgentDTO> {
    const row = await this.prisma.agent.findUnique({
      where: { id },
      include: { machine: { select: { name: true } } },
    });
    if (!row) throw new NotFoundException('agent not found');
    return MachineService.agentToDto(row, row.machine.name);
  }

  /**
   * Soft-archives an agent: hides it from the default sidebar list but
   * keeps the row (and therefore all its sessions / commands / chunks)
   * intact. The supervisor on the sidecar keeps running — archiving is
   * a UI concern, not a process-control one. To stop the supervisor,
   * use DELETE /machines/:id/agents/:agentId.
   */
  async archive(id: string): Promise<AgentDTO> {
    const row = await this.prisma.agent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('agent not found');
    const saved = await this.prisma.agent.update({
      where: { id },
      data: { archivedAt: new Date() },
      include: { machine: { select: { name: true } } },
    });
    const dto = MachineService.agentToDto(saved, saved.machine.name);
    this.gateway.emitAgentUpsert(dto);
    this.logger.log(`archived ${id}`);
    return dto;
  }

  async unarchive(id: string): Promise<AgentDTO> {
    const row = await this.prisma.agent.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('agent not found');
    const saved = await this.prisma.agent.update({
      where: { id },
      data: { archivedAt: null },
      include: { machine: { select: { name: true } } },
    });
    const dto = MachineService.agentToDto(saved, saved.machine.name);
    this.gateway.emitAgentUpsert(dto);
    this.logger.log(`unarchived ${id}`);
    return dto;
  }

  /** Internal helper for callers that need the raw row (e.g. terminal/command). */
  getRow(id: string): Promise<PAgent | null> {
    return this.prisma.agent.findUnique({ where: { id } });
  }
}
