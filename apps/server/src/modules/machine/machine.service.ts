import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Agent as PAgent, Machine as PMachine, Prisma } from '@prisma/client';
import {
  consumerGroups,
  streamKeys,
  type AgentDTO,
  type AgentSpec,
  type AnyLifecycleEvent,
  type AvailableAdapter,
  type CreateAgentRequest,
  type MachineDTO,
} from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { FSService } from './fs.service';
import { SidecarUpdateService } from './sidecar-update.service';

const CONSUMER = 'server-1';
const STALE_AFTER_MS = 30_000;
const SWEEP_INTERVAL_MS = 15_000;

/**
 * MachineService is the server-side counterpart to the Go machine
 * daemon. It owns:
 *
 *   - The lifecycle Redis stream consumer that ingests
 *     machine-register / machine-heartbeat / agent-spawned /
 *     agent-spawn-failed / agent-destroyed events (plus the per-agent
 *     register / heartbeat / deregister events).
 *   - The reverse channel: REST endpoints for the dashboard land here
 *     (createAgent / destroyAgent), and we publish CreateAgent /
 *     DestroyAgent commands onto each machine's machine:M:control
 *     stream.
 *   - A periodic sweeper that flips machines + their agents to
 *     `offline` when heartbeats lapse, so the UI doesn't show
 *     phantom-online hosts after a sidecar crash.
 *
 * We keep both lifecycle ingest and command publish in one service
 * because they share the Machine ↔ Agent invariants (e.g. don't send
 * a CreateAgent to an offline machine without queueing it on the
 * stream — Redis Streams already buffer).
 */
@Injectable()
export class MachineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MachineService.name);
  private running = false;
  private sweepTimer?: NodeJS.Timeout;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
    private readonly fs: FSService,
    private readonly sidecarUpdate: SidecarUpdateService,
  ) {}

  async onModuleInit() {
    await this.redis.ensureGroup(streamKeys.lifecycle, consumerGroups.lifecycle);
    this.running = true;
    this.loopPromise = this.consumeLoop();
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.race([this.loopPromise, new Promise((r) => setTimeout(r, 6_000))]);
  }

  // ───────────────────── REST surface ─────────────────────

  async listMachines(includeArchived = false): Promise<MachineDTO[]> {
    const rows = await this.prisma.machine.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { agents: true } } },
    });
    return rows.map((r) => MachineService.toDto(r, r._count.agents));
  }

  async getMachine(id: string): Promise<MachineDTO> {
    const row = await this.prisma.machine.findUnique({
      where: { id },
      include: { _count: { select: { agents: true } } },
    });
    if (!row) throw new NotFoundException('machine not found');
    return MachineService.toDto(row, row._count.agents);
  }

  /**
   * Persist the user's icon choice for `machineId` and broadcast the
   * resulting MachineDTO so every connected dashboard refreshes the
   * glyph in lockstep. We accept null as "reset to default" rather
   * than introducing a separate DELETE endpoint — the picker only
   * exposes "pick a glyph", and a future "reset" affordance can hit
   * the same endpoint with `{ iconKey: null }`.
   */
  async setIcon(machineId: string, iconKey: string | null): Promise<MachineDTO> {
    const trimmed = typeof iconKey === 'string' ? iconKey.trim() : null;
    const next = trimmed ? trimmed : null;

    const exists = await this.prisma.machine.findUnique({
      where: { id: machineId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('machine not found');

    const updated = await this.prisma.machine.update({
      where: { id: machineId },
      data: { iconKey: next },
      include: { _count: { select: { agents: true } } },
    });
    const dto = MachineService.toDto(updated, updated._count.agents);
    this.gateway.emitMachineUpsert(dto);
    return dto;
  }

  async listAgentsForMachine(machineId: string): Promise<AgentDTO[]> {
    const rows = await this.prisma.agent.findMany({
      where: { machineId, archivedAt: null },
      include: { machine: { select: { name: true } } },
      orderBy: [{ name: 'asc' }],
    });
    return rows.map((r) => MachineService.agentToDto(r, r.machine.name));
  }

  /**
   * Create an Agent row and push a `create-agent` control command to
   * the target machine's sidecar. We persist before publishing so a
   * Redis hiccup doesn't leave the dashboard with a ghost agent.
   *
   * The agent boots into `offline` status; the sidecar's
   * RegisterEvent flips it `online` once the supervisor is up.
   */
  async createAgent(machineId: string, req: CreateAgentRequest): Promise<AgentDTO> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId } });
    if (!machine) throw new NotFoundException('machine not found');
    if (machine.archivedAt) throw new BadRequestException('machine is archived');

    if (!req.name?.trim()) throw new BadRequestException('name is required');
    if (!req.type?.trim()) throw new BadRequestException('type is required');

    const adapters = (machine.availableAdapters ?? []) as unknown as AvailableAdapter[];
    if (Array.isArray(adapters) && adapters.length > 0) {
      const known = new Set(adapters.map((a) => a.type));
      if (!known.has(req.type)) {
        throw new BadRequestException(
          `adapter type "${req.type}" is not installed on machine "${machine.name}". Installed: ${[...known].join(', ') || '(none)'}`,
        );
      }
    }

    const now = new Date();
    let row: PAgent;
    try {
      row = await this.prisma.agent.create({
        data: {
          name: req.name.trim(),
          machineId,
          type: req.type,
          status: 'offline',
          supportsTerminal: req.supportsTerminal ?? false,
          workingDir: req.workingDir ?? null,
          lastHeartbeatAt: now,
          registeredAt: now,
        },
      });
    } catch (err) {
      // Surface the unique-constraint failure as a friendlier 400.
      if ((err as { code?: string }).code === 'P2002') {
        throw new BadRequestException(
          `an agent named "${req.name}" already exists on this machine`,
        );
      }
      throw err;
    }

    const spec: AgentSpec = {
      agentId: row.id,
      name: row.name,
      type: row.type,
      workingDir: row.workingDir ?? undefined,
      supportsTerminal: row.supportsTerminal,
      adapter: req.adapter,
    };
    await this.publishControl(machineId, {
      kind: 'create-agent',
      agent: spec,
      ts: Date.now(),
    });

    const dto = MachineService.agentToDto(row, machine.name);
    this.gateway.emitAgentUpsert(dto);
    return dto;
  }

  /**
   * Destroy an Agent: hard-delete the row (cascading to its sessions /
   * commands / chunks / terminals) and push a `destroy-agent` control
   * command to the sidecar so it stops the supervisor and drops the
   * agent from its on-disk cache.
   *
   * We hard-delete (not archive) here — the dashboard surface for this
   * operation is a destructive "remove from machine", semantically
   * different from the existing per-agent archive button which keeps
   * history.
   */
  async destroyAgent(machineId: string, agentId: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('agent not found');
    if (agent.machineId !== machineId) {
      throw new BadRequestException('agent does not belong to this machine');
    }

    await this.publishControl(machineId, {
      kind: 'destroy-agent',
      agentId,
      ts: Date.now(),
    });
    await this.prisma.agent.delete({ where: { id: agentId } });
    this.gateway.emitAgentRemoved(agentId);
  }

  /**
   * Fan out a `sync-user-rules` control command to every online,
   * unarchived machine. Called when a user saves their rules text;
   * the sidecar writes the content to each installed CLI's
   * conventional rules file (claude-code → ~/.claude/CLAUDE.md,
   * codex → ~/.codex/AGENTS.md).
   *
   * Best-effort: per-machine publish errors are logged but never
   * fail the call. Persistence in `User.rules` is the source of
   * truth; if a machine is offline or the publish drops, the user
   * can re-Save to retry the fanout. We deliberately skip offline
   * machines rather than relying on Redis stream buffering — the
   * control stream's MAXLEN (200) makes long-offline catch-up
   * unreliable, and a stale rules push isn't worth the complexity.
   */
  async syncUserRulesAll(rules: string): Promise<void> {
    const machines = await this.prisma.machine.findMany({
      where: { status: 'online', archivedAt: null },
      select: { id: true, name: true },
    });
    if (machines.length === 0) {
      this.logger.log('sync-user-rules: no online machines to sync');
      return;
    }
    const ts = Date.now();
    const results = await Promise.allSettled(
      machines.map((m) =>
        this.publishControl(m.id, { kind: 'sync-user-rules', rules, ts }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    this.logger.log(
      `sync-user-rules → ${machines.length - failed}/${machines.length} machine(s) (${rules.length} byte(s))`,
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        this.logger.warn(
          `sync-user-rules: ${machines[i].name} (${machines[i].id}) publish failed: ${(r.reason as Error)?.message ?? String(r.reason)}`,
        );
      }
    }
  }

  // ───────────────────── Lifecycle ingest ─────────────────────

  private async publishControl(machineId: string, payload: unknown): Promise<void> {
    await this.redis.publish(streamKeys.machineControl(machineId), payload);
  }

  /**
   * Push the canonical agent set down to a freshly-(re)connected
   * sidecar. Called whenever a machine-register lands so a sidecar
   * that missed a CreateAgent / DestroyAgent while offline catches up
   * without operator intervention.
   */
  private async syncAgents(machineId: string): Promise<void> {
    const rows = await this.prisma.agent.findMany({
      where: { machineId, archivedAt: null },
    });
    const specs: AgentSpec[] = rows.map((r) => ({
      agentId: r.id,
      name: r.name,
      type: r.type,
      workingDir: r.workingDir ?? undefined,
      supportsTerminal: r.supportsTerminal,
    }));
    await this.publishControl(machineId, {
      kind: 'sync-agents',
      agents: specs,
      ts: Date.now(),
    });
    this.logger.log(`sync-agents → ${machineId}: ${specs.length} agent(s)`);
  }

  private async consumeLoop() {
    while (this.running) {
      try {
        const res = (await this.redis.read.xreadgroup(
          'GROUP',
          consumerGroups.lifecycle,
          CONSUMER,
          'COUNT',
          50,
          'BLOCK',
          5_000,
          'STREAMS',
          streamKeys.lifecycle,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) continue;
        for (const [, entries] of res) {
          for (const [msgId, fields] of entries) {
            try {
              const data = parseData(fields);
              if (data) await this.handle(data as AnyLifecycleEvent);
            } catch (err) {
              this.logger.error(`failed to handle lifecycle event: ${(err as Error).message}`);
            }
            await this.redis.cmd.xack(streamKeys.lifecycle, consumerGroups.lifecycle, msgId);
          }
        }
      } catch (err) {
        if (this.running) {
          this.logger.error(`lifecycle loop error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  private async handle(ev: AnyLifecycleEvent) {
    switch (ev.kind) {
      case 'machine-register': {
        const now = new Date();
        const adapters = ev.availableAdapters ?? [];
        const saved = await this.prisma.machine.upsert({
          where: { id: ev.machineId },
          create: {
            id: ev.machineId,
            name: ev.name,
            hostname: ev.hostname,
            os: ev.os,
            arch: ev.arch,
            sidecarVersion: ev.sidecarVersion,
            availableAdapters: adapters as unknown as Prisma.InputJsonValue,
            status: 'online',
            lastSeenAt: now,
            registeredAt: now,
            archivedAt: null,
          },
          update: {
            name: ev.name,
            hostname: ev.hostname,
            os: ev.os,
            arch: ev.arch,
            sidecarVersion: ev.sidecarVersion,
            availableAdapters: adapters as unknown as Prisma.InputJsonValue,
            status: 'online',
            lastSeenAt: now,
            // Re-register clears archived state — the sidecar declared
            // itself live, so the dashboard should treat the machine as
            // visible regardless of any prior soft-archive.
            archivedAt: null,
          },
        });
        const count = await this.prisma.agent.count({ where: { machineId: saved.id } });
        this.gateway.emitMachineUpsert(MachineService.toDto(saved, count));
        this.logger.log(
          `machine-register ${ev.machineId} (${ev.name} / ${ev.os}/${ev.arch}, sidecar ${ev.sidecarVersion}, ${adapters.length} adapter(s))`,
        );
        // If a remote-triggered self-update was waiting for this
        // machine to come back on the new binary, fire `completed`
        // and resolve the bulk-loop promise.
        this.sidecarUpdate.observeMachineRegister(ev.machineId, ev.sidecarVersion);
        await this.syncAgents(ev.machineId);
        break;
      }
      case 'machine-heartbeat': {
        const saved = await this.prisma.machine
          .update({
            where: { id: ev.machineId },
            data: { status: 'online', lastSeenAt: new Date() },
          })
          .catch(() => null);
        if (saved) this.gateway.emitMachineStatus(saved.id, 'online');
        break;
      }
      case 'register': {
        const now = new Date();
        const workingDir = ev.workingDir ?? null;
        const machine = await this.prisma.machine.findUnique({ where: { id: ev.machineId } });
        if (!machine) {
          this.logger.warn(
            `register for unknown machine ${ev.machineId} (agent ${ev.id}); ignoring until machine-register lands`,
          );
          break;
        }
        const saved = await this.prisma.agent
          .update({
            where: { id: ev.id },
            data: {
              type: ev.type,
              status: 'online',
              supportsTerminal: ev.supportsTerminal,
              version: ev.version,
              workingDir,
              lastHeartbeatAt: now,
            },
          })
          .catch((err) => {
            // Most likely cause: the agent row was destroyed while the
            // sidecar was still trying to register it. Quietly drop —
            // the sidecar will catch up on the next sync-agents.
            this.logger.warn(
              `register for unknown agent ${ev.id} (machine ${ev.machineId}): ${(err as Error).message}`,
            );
            return null;
          });
        if (saved) {
          this.gateway.emitAgentUpsert(MachineService.agentToDto(saved, machine.name));
        }
        break;
      }
      case 'heartbeat': {
        const saved = await this.prisma.agent
          .update({
            where: { id: ev.id },
            data: { status: ev.status, lastHeartbeatAt: new Date() },
          })
          .catch(() => null);
        if (saved) this.gateway.emitAgentStatus(saved.id, saved.status as AgentDTO['status']);
        break;
      }
      case 'deregister': {
        const saved = await this.prisma.agent
          .update({ where: { id: ev.id }, data: { status: 'offline' } })
          .catch(() => null);
        if (saved) this.gateway.emitAgentStatus(saved.id, 'offline');
        break;
      }
      case 'agent-spawned': {
        // The supervisor will follow up with a `register` that sets
        // status=online; this event is purely a UI nudge that the
        // sidecar acknowledged the create-agent command.
        this.logger.log(`agent-spawned ${ev.agentId} on ${ev.machineId}`);
        break;
      }
      case 'agent-spawn-failed': {
        this.logger.error(`agent-spawn-failed ${ev.agentId} on ${ev.machineId}: ${ev.reason}`);
        this.gateway.emitAgentSpawnFailed({
          machineId: ev.machineId,
          agentId: ev.agentId,
          reason: ev.reason,
        });
        // Reflect the failure in the row so the dashboard can paint an
        // error pill rather than leaving the agent stuck at "offline".
        await this.prisma.agent
          .update({ where: { id: ev.agentId }, data: { status: 'error' } })
          .catch(() => null);
        this.gateway.emitAgentStatus(ev.agentId, 'error');
        break;
      }
      case 'agent-destroyed': {
        // Sidecar acked the destroy. The row was already deleted by
        // destroyAgent; nothing more to do.
        this.logger.log(`agent-destroyed ${ev.agentId} on ${ev.machineId}`);
        break;
      }
      case 'fs-list-response': {
        // Forwarded to FSService which resolves the pending REST call.
        // No-op if the request already timed out (late response).
        this.fs.handleResponse(ev);
        break;
      }
      case 'fs-read-response': {
        // Same fan-in as fs-list-response — FSService keeps a single
        // pending map keyed by requestId for both kinds.
        this.fs.handleReadResponse(ev);
        break;
      }
      case 'fs-changed': {
        // Debounced notification from the sidecar's fsnotify watcher.
        // Broadcast into the agent room so connected dashboards can
        // invalidate their cached tree listings.
        this.gateway.emitFSChanged({ agentId: ev.agentId, path: ev.path });
        break;
      }
      case 'git-log-response': {
        // Same fan-in as fs-list-response — keyed by requestId in the
        // shared pending map.
        this.fs.handleGitLogResponse(ev);
        break;
      }
      case 'git-changed': {
        // Debounced notification from the sidecar's secondary git
        // watcher (.git/HEAD + refs/heads/). Broadcast into the agent
        // room so connected dashboards can refresh their commit panel.
        this.gateway.emitGitChanged({ agentId: ev.agentId });
        break;
      }
      case 'sidecar-update-started':
      case 'sidecar-update-downloaded':
      case 'sidecar-update-failed': {
        // Three-phase progress for a remote-triggered self-update.
        // SidecarUpdateService fans this out to the dashboard and
        // resolves the per-machine + bulk-loop promises.
        this.sidecarUpdate.handleUpdateEvent(ev);
        break;
      }
    }
  }

  private async sweepStale() {
    const threshold = new Date(Date.now() - STALE_AFTER_MS);

    // Machines: flip stale to offline, plus every agent that lives on
    // them (the sidecar process is gone, so no agent on it can be live
    // either — the per-agent heartbeat sweep below would catch them
    // eventually but doing it together is faster and avoids a brief
    // window where the UI shows an offline machine with online agents).
    const staleMachines = await this.prisma.machine.findMany({
      where: { status: { not: 'offline' }, lastSeenAt: { lt: threshold } },
      select: { id: true },
    });
    if (staleMachines.length > 0) {
      const ids = staleMachines.map((m) => m.id);
      await this.prisma.machine.updateMany({
        where: { id: { in: ids } },
        data: { status: 'offline' },
      });
      const orphanedAgents = await this.prisma.agent.findMany({
        where: { machineId: { in: ids }, status: { not: 'offline' } },
        select: { id: true },
      });
      if (orphanedAgents.length > 0) {
        await this.prisma.agent.updateMany({
          where: { id: { in: orphanedAgents.map((a) => a.id) } },
          data: { status: 'offline' },
        });
        for (const { id } of orphanedAgents) this.gateway.emitAgentStatus(id, 'offline');
      }
      for (const id of ids) this.gateway.emitMachineStatus(id, 'offline');
      this.logger.warn(
        `swept ${staleMachines.length} stale machine(s), ${orphanedAgents.length} orphaned agent(s)`,
      );
    }

    // Agents whose machine is fine but whose own heartbeat lapsed
    // (e.g. supervisor crashed but daemon kept running).
    const staleAgents = await this.prisma.agent.findMany({
      where: { status: { not: 'offline' }, lastHeartbeatAt: { lt: threshold } },
      select: { id: true },
    });
    if (staleAgents.length > 0) {
      await this.prisma.agent.updateMany({
        where: { id: { in: staleAgents.map((s) => s.id) } },
        data: { status: 'offline' },
      });
      for (const { id } of staleAgents) this.gateway.emitAgentStatus(id, 'offline');
      this.logger.warn(`swept ${staleAgents.length} stale agent(s)`);
    }
  }

  // ───────────────────── DTOs ─────────────────────

  static toDto(m: PMachine, agentCount: number): MachineDTO {
    return {
      id: m.id,
      name: m.name,
      hostname: m.hostname,
      os: m.os,
      arch: m.arch,
      sidecarVersion: m.sidecarVersion,
      availableAdapters: (m.availableAdapters ?? []) as unknown as AvailableAdapter[],
      status: m.status as MachineDTO['status'],
      lastSeenAt: m.lastSeenAt.toISOString(),
      registeredAt: m.registeredAt.toISOString(),
      archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
      agentCount,
      iconKey: m.iconKey ?? null,
    };
  }

  static agentToDto(a: PAgent, machineName: string): AgentDTO {
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      machineId: a.machineId,
      machineName,
      status: a.status as AgentDTO['status'],
      supportsTerminal: a.supportsTerminal,
      version: a.version,
      workingDir: a.workingDir,
      lastHeartbeatAt: a.lastHeartbeatAt.toISOString(),
      registeredAt: a.registeredAt.toISOString(),
      archivedAt: a.archivedAt ? a.archivedAt.toISOString() : null,
    };
  }
}

function parseData(fields: string[]): unknown | null {
  for (let i = 0; i < fields.length - 1; i += 2) {
    if (fields[i] === 'data') {
      try {
        return JSON.parse(fields[i + 1]!);
      } catch {
        return null;
      }
    }
  }
  return null;
}
