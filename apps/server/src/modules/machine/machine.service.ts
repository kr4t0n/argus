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
  type AgentQuota,
  type AgentSpec,
  type AnyLifecycleEvent,
  type AvailableAdapter,
  type CreateAgentRequest,
  type HeartbeatEvent,
  type MachineDTO,
  type MachineHeartbeatEvent,
} from '@argus/shared-types';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';
import { FSService } from './fs.service';
import { ModelsService } from './models.service';
import { SidecarUpdateService, stripSidecarPrefix } from './sidecar-update.service';

const CONSUMER = 'server-1';
const STALE_AFTER_MS = 30_000;
const SWEEP_INTERVAL_MS = 15_000;

/** Event kinds whose handlers do no DB work — RPC responses resolve a
 *  requestId-keyed pending promise, watcher nudges are pure WS emits.
 *  Handled before everything else in each batch: the FSService timers
 *  (5s/15s) run on wall clock, and a response queued behind a batch of
 *  DB-bound heartbeats used to time out before its handler ever ran.
 *  Reordering is safe because these handlers touch no state the status
 *  events write. */
const FAST_KINDS = new Set<AnyLifecycleEvent['kind']>([
  'fs-list-response',
  'fs-read-response',
  'git-log-response',
  'model-catalog-response',
  'fs-changed',
  'git-changed',
  'sidecar-update-started',
  'sidecar-update-downloaded',
  'sidecar-update-failed',
]);

/**
 * MachineService is the server-side counterpart to the Go machine
 * daemon. It owns:
 *
 *   - The lifecycle Redis stream consumer that ingests
 *     machine-register / machine-heartbeat / agent-spawned /
 *     agent-spawn-failed / agent-destroyed events (plus the per-agent
 *     register / heartbeat / deregister events). The same blocking
 *     read also drains `agent:notify`, the watcher-nudge stream
 *     (fs-changed / git-changed) — split off so nudge bursts can't
 *     MAXLEN-trim unread heartbeats.
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
    private readonly models: ModelsService,
    private readonly sidecarUpdate: SidecarUpdateService,
  ) {}

  async onModuleInit() {
    await this.redis.ensureGroup(streamKeys.lifecycle, consumerGroups.lifecycle);
    // Same group name on the notify stream so one XREADGROUP drains
    // both — see the consumerGroups.lifecycle comment in shared-types.
    await this.redis.ensureGroup(streamKeys.notify, consumerGroups.lifecycle);
    await this.reclaimStalePending();
    this.running = true;
    this.loopPromise = this.consumeLoop();
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
  }

  /**
   * Clear this consumer's leftover pending-entries backlog from a prior
   * run before the main loop starts.
   *
   * The lifecycle loop reads with '>' (new messages only) under a fixed
   * consumer name (`server-1`), so any entries delivered to that consumer
   * but not acked before a crash / restart / OOM are never redelivered —
   * '>' skips them. They sit in the PEL, and once MAXLEN trims the
   * underlying stream entries those PEL references become unreclaimable
   * phantoms that grow without bound across restarts (observed live:
   * 3,200+ stuck pending on `server-lifecycle` after an OOM).
   *
   * We read our own pending list with ID '0' and XACK it. Entries that
   * still exist are stale by definition — the sidecar re-sends
   * register/heartbeat every 5s and the '>' loop already applied anything
   * current — and trimmed entries are phantoms; either way the correct
   * action is to drop them, not replay (replaying stale heartbeats would
   * briefly mark dead machines online). Runs before consumeLoop starts, so
   * the dedicated blocking `read` connection is exclusively ours here.
   *
   * Covers every stream the group is registered on — the notify stream
   * has the same fixed-consumer '>' exposure as lifecycle, and its
   * nudges are even more clearly drop-not-replay (a stale "something
   * changed" is refreshed by the next real one).
   */
  private async reclaimStalePending(): Promise<void> {
    for (const stream of [streamKeys.lifecycle, streamKeys.notify]) {
      try {
        let cleared = 0;
        // XACK removes acked ids from the PEL, so each '0' read returns the
        // next pending batch and the loop drains it. The iteration cap is a
        // belt-and-suspenders backstop against a non-terminating read.
        for (let i = 0; i < 10_000; i++) {
          const res = (await this.redis.read.xreadgroup(
            'GROUP',
            consumerGroups.lifecycle,
            CONSUMER,
            'COUNT',
            500,
            'STREAMS',
            stream,
            '0',
          )) as Array<[string, Array<[string, string[]]>]> | null;
          const entries = res?.[0]?.[1] ?? [];
          if (entries.length === 0) break;
          await this.redis.cmd.xack(stream, consumerGroups.lifecycle, ...entries.map(([id]) => id));
          cleared += entries.length;
          if (entries.length < 500) break;
        }
        if (cleared > 0) {
          this.logger.log(`${stream}: cleared ${cleared} stale pending entr(ies) from a prior run`);
        }
      } catch (err) {
        this.logger.warn(`${stream}: reclaim of stale pending failed: ${(err as Error).message}`);
      }
    }
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.race([this.loopPromise, new Promise((r) => setTimeout(r, 6_000))]);
  }

  // ───────────────────── REST surface ─────────────────────

  async listMachines(includeArchived = false): Promise<MachineDTO[]> {
    const rows = await this.prisma.machine.findMany({
      // Soft-deleted machines are gone for good — never surfaced, not
      // even via `includeArchived` (that flag is about archive, which
      // is a separate, reversible concept).
      where: { deletedAt: null, ...(includeArchived ? {} : { archivedAt: null }) },
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
    if (!row || row.deletedAt) throw new NotFoundException('machine not found');
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
      select: { id: true, deletedAt: true },
    });
    if (!exists || exists.deletedAt) throw new NotFoundException('machine not found');

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
    if (!machine || machine.deletedAt) throw new NotFoundException('machine not found');
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
    // Reclaim the agent's Redis streams now. This covers the
    // sidecar-offline case (no `agent-destroyed` ack will come); if the
    // sidecar is online, its ack path DELs again once the supervisor is
    // torn down, cleaning up any stream a late supervisor write recreated
    // in the gap. See `deleteAgentStreams`.
    await this.deleteAgentStreams(agentId);
    this.gateway.emitAgentRemoved(agentId);
  }

  /**
   * Best-effort removal of a destroyed agent's Redis streams (command +
   * result). Redis streams have no TTL, so without this every agent ever
   * destroyed leaves its `agent:{id}:cmd` / `agent:{id}:result` streams —
   * and their consumer groups, which DEL takes with them — in Redis
   * forever, monotonically growing the footprint on a bridge that is
   * supposed to hold no permanent data.
   *
   * Safe because Redis is only a transient bridge: the read path is
   * Postgres, and a destroyed agent's sessions/commands/chunks are
   * cascade-deleted with the row, so nothing downstream needs these
   * entries. Both readers self-heal from the resulting NOGROUP — the
   * sidecar's machine-wide command reader re-ensures groups + re-snapshots
   * its agent set, and the result-ingestor re-syncs its stream list (see
   * its NOGROUP branch).
   */
  private async deleteAgentStreams(agentId: string): Promise<void> {
    try {
      const removed = await this.redis.cmd.del(
        streamKeys.command(agentId),
        streamKeys.result(agentId),
      );
      if (removed > 0) {
        this.logger.log(`deleted ${removed} Redis stream(s) for destroyed agent ${agentId}`);
      }
    } catch (err) {
      this.logger.warn(
        `failed to delete Redis streams for agent ${agentId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Soft-delete a Machine: set the sticky `deletedAt` tombstone and
   * archive its agents, then broadcast `machine:removed` so every
   * dashboard drops it. NOTHING is destroyed — the agents are merely
   * hidden via their own `archivedAt`, and the
   * sessions/commands/chunks/terminals beneath them stay fully intact
   * so conversation history survives and remains viewable through the
   * normal (user-scoped) session UI.
   *
   * Safe at any status, so there's no online guard: the
   * `machine-register` / `machine-heartbeat` handlers ignore any row
   * whose `deletedAt` is set and never clear it, so a still-running or
   * restarting sidecar can't resurrect the machine. Deleting a live
   * machine just stops the server tracking it; the remote sidecar
   * keeps running, untouched (we don't reach out to kill its agents).
   *
   * `Machine.name` is `@unique`; we suffix it on delete so a fresh
   * install can reuse the human-facing name without colliding with
   * the tombstone row. Terminal by design — no un-delete from the UI.
   */
  async removeMachine(id: string): Promise<void> {
    const machine = await this.prisma.machine.findUnique({
      where: { id },
      select: { id: true, name: true, deletedAt: true },
    });
    // Already-deleted rows are invisible everywhere else, so treat a
    // repeat delete as "not found" rather than leaking the tombstone.
    if (!machine || machine.deletedAt) {
      throw new NotFoundException('machine not found');
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.machine.update({
        where: { id },
        data: {
          deletedAt: now,
          status: 'offline',
          // Free the unique display name for a future fresh install.
          name: `${machine.name} (deleted ${now.toISOString()})`,
        },
      }),
      // Soft-hide the agents — reuses the existing archive filtering.
      // Deliberately NOT a delete: every agent's sessions and history
      // hang off these rows and must outlive the machine.
      this.prisma.agent.updateMany({
        where: { machineId: id, archivedAt: null },
        data: { archivedAt: now },
      }),
    ]);

    this.gateway.emitMachineRemoved(id);
    this.logger.log(`machine ${id} (${machine.name}) soft-deleted`);
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
      where: { status: 'online', archivedAt: null, deletedAt: null },
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
        // One blocking read covers both the lifecycle stream and the
        // notify stream (fs-changed / git-changed nudges). The split
        // is about MAXLEN buffer isolation — a nudge burst trimming
        // unread heartbeats — not consumer isolation, so batches from
        // both streams go through the same processBatch and the batch
        // ack targets whichever stream it came from. Old sidecars that
        // still publish nudges on lifecycle keep working: routing is
        // by event kind.
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
          streamKeys.notify,
          '>',
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) continue;
        for (const [stream, entries] of res) {
          await this.processBatch(stream, entries);
        }
      } catch (err) {
        if (this.running) {
          const msg = (err as Error).message;
          // Self-heal after the group vanishes (Redis flush, or an
          // emergency DEL of one stream — DEL takes its groups along,
          // and the next XADD recreates the stream without them).
          // One XREADGROUP spans BOTH streams and NOGROUP on either
          // fails the whole call, so re-ensure both: healing only
          // lifecycle would leave a group-less agent:notify wedging
          // lifecycle consumption forever.
          if (msg.includes('NOGROUP')) {
            await this.redis
              .ensureGroup(streamKeys.lifecycle, consumerGroups.lifecycle)
              .catch(() => {});
            await this.redis
              .ensureGroup(streamKeys.notify, consumerGroups.lifecycle)
              .catch(() => {});
          }
          this.logger.error(`lifecycle loop error: ${msg}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  /**
   * Handle one XREADGROUP batch from `stream`, then ack the whole batch
   * with a single variadic XACK.
   *
   * The per-entry `await xack` this replaces was the consumer's
   * bottleneck: at ~144ms RTT to a remote Redis, acking 50 entries one
   * at a time cost ~7s per batch before any real work, and per-entry
   * Prisma writes pushed throughput below heartbeat inflow — the
   * backlog grew until MAXLEN trimmed entries that were never delivered
   * (observed live: group lag > stream length), which is how fs/git RPC
   * responses vanished and every panel request "timed out". Batch-acking
   * doesn't weaken delivery semantics: a crash mid-batch leaves the
   * whole batch in the PEL, and reclaimStalePending() already drops —
   * never replays — leftover PEL entries on boot.
   *
   * Within the batch: no-DB handlers first (see FAST_KINDS), then
   * heartbeats coalesced to the newest per agent / per machine and
   * applied as grouped writes, then everything else in stream order.
   * Coalescing drops only redundant older heartbeats — no information
   * the newest doesn't carry. The one ordering change vs strict stream
   * order: a heartbeat that arrived *after* a deregister in the same
   * batch now applies before it, briefly showing the agent offline
   * until its next 5s heartbeat — preferred over the reverse inversion
   * (a deregistered agent shown online until the 30s stale sweep).
   */
  private async processBatch(stream: string, entries: Array<[string, string[]]>): Promise<void> {
    if (entries.length === 0) return;

    const agentBeats = new Map<string, HeartbeatEvent>();
    const machineBeats = new Map<string, MachineHeartbeatEvent>();
    // Quotas ride only on *some* machine-heartbeats. Track the newest
    // quota-carrying event separately so coalescing to the newest
    // heartbeat can't discard a fresh quota snapshot that happened to
    // arrive on an older entry in the same batch.
    const machineQuotaBeats = new Map<string, MachineHeartbeatEvent>();
    const rest: AnyLifecycleEvent[] = [];

    for (const [, fields] of entries) {
      const ev = parseData(fields) as AnyLifecycleEvent | null;
      if (!ev) continue;
      if (FAST_KINDS.has(ev.kind)) {
        try {
          await this.handle(ev);
        } catch (err) {
          this.logger.error(`failed to handle lifecycle event: ${(err as Error).message}`);
        }
      } else if (ev.kind === 'heartbeat') {
        agentBeats.set(ev.id, ev);
      } else if (ev.kind === 'machine-heartbeat') {
        machineBeats.set(ev.machineId, ev);
        if (ev.quotas?.length) machineQuotaBeats.set(ev.machineId, ev);
      } else {
        rest.push(ev);
      }
    }

    await this.applyAgentHeartbeats([...agentBeats.values()]);
    for (const [machineId, ev] of machineBeats) {
      await this.applyMachineHeartbeat(ev, machineQuotaBeats.get(machineId));
    }
    for (const ev of rest) {
      try {
        await this.handle(ev);
      } catch (err) {
        this.logger.error(`failed to handle lifecycle event: ${(err as Error).message}`);
      }
    }

    await this.redis.cmd.xack(
      stream,
      consumerGroups.lifecycle,
      ...entries.map(([msgId]) => msgId),
    );
  }

  /**
   * Apply a batch of coalesced per-agent heartbeats: one findMany (to
   * learn which ids still exist — updateMany can't report that) plus
   * one updateMany per distinct status, all in flight together, instead
   * of one agent.update round trip per event. Status is emitted only
   * for rows that exist, matching the old per-row
   * `update().catch(() => null)` behavior for destroyed agents.
   */
  private async applyAgentHeartbeats(beats: HeartbeatEvent[]): Promise<void> {
    if (beats.length === 0) return;
    const now = new Date();
    const byStatus = new Map<string, string[]>();
    for (const ev of beats) {
      const ids = byStatus.get(ev.status) ?? [];
      ids.push(ev.id);
      byStatus.set(ev.status, ids);
    }
    try {
      const existingPromise = this.prisma.agent.findMany({
        where: { id: { in: beats.map((b) => b.id) } },
        select: { id: true },
      });
      await Promise.all(
        [...byStatus.entries()].map(([status, ids]) =>
          this.prisma.agent.updateMany({
            where: { id: { in: ids } },
            data: { status, lastHeartbeatAt: now },
          }),
        ),
      );
      const known = new Set((await existingPromise).map((r) => r.id));
      for (const ev of beats) {
        if (known.has(ev.id)) {
          this.gateway.emitAgentStatus(ev.id, ev.status as AgentDTO['status']);
        }
      }
    } catch (err) {
      this.logger.error(`failed to apply agent heartbeats: ${(err as Error).message}`);
    }
  }

  /**
   * Apply the newest machine-heartbeat for one machine. `quotaEv` is
   * the newest quota-carrying heartbeat from the same batch (possibly
   * an older entry than `ev` — see processBatch).
   */
  private async applyMachineHeartbeat(
    ev: MachineHeartbeatEvent,
    quotaEv?: MachineHeartbeatEvent,
  ): Promise<void> {
    try {
      // `updateMany` (not `update`) so the `deletedAt: null` filter
      // is part of the WHERE: a soft-deleted machine matches zero
      // rows and the heartbeat is a no-op (no status flip on a
      // tombstone, no resurrection), same as an unknown machineId.
      const res = await this.prisma.machine.updateMany({
        where: { id: ev.machineId, deletedAt: null },
        data: { status: 'online', lastSeenAt: new Date() },
      });
      if (res.count > 0) {
        this.gateway.emitMachineStatus(ev.machineId, 'online');
        if (quotaEv?.quotas?.length) {
          await this.persistQuotas(ev.machineId, quotaEv.quotas);
        }
      }
    } catch (err) {
      this.logger.error(`failed to apply machine heartbeat: ${(err as Error).message}`);
    }
  }

  private async handle(ev: AnyLifecycleEvent) {
    switch (ev.kind) {
      case 'machine-register': {
        const now = new Date();
        const adapters = ev.availableAdapters ?? [];
        // Normalize the reported sidecar version so the DB always stores
        // bare semver (`0.1.11`) — the running binary reports its raw
        // `main.Version` ldflag, which is the full tag name
        // (`argus-sidecar-v0.1.11`) when built by argus-sidecar-release.yml.
        // Without this, every downstream comparator and "from X to Y"
        // toast sees mismatched shapes against the prefix-stripped GH
        // latest tag.
        const sidecarVersion = stripSidecarPrefix(ev.sidecarVersion);
        // Sticky soft-delete: a deleted machine stays deleted even if
        // its sidecar is still alive and re-registering. Ignore the
        // event entirely — no upsert (which would resurrect the row),
        // no emit, no agent reconcile. The remote sidecar keeps running
        // untouched; the server has simply forgotten it.
        const tomb = await this.prisma.machine.findUnique({
          where: { id: ev.machineId },
          select: { deletedAt: true },
        });
        if (tomb?.deletedAt) {
          this.logger.warn(
            `ignoring machine-register from soft-deleted machine ${ev.machineId} (${ev.name})`,
          );
          break;
        }
        const saved = await this.prisma.machine.upsert({
          where: { id: ev.machineId },
          create: {
            id: ev.machineId,
            name: ev.name,
            hostname: ev.hostname,
            os: ev.os,
            arch: ev.arch,
            sidecarVersion,
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
            sidecarVersion,
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
          `machine-register ${ev.machineId} (${ev.name} / ${ev.os}/${ev.arch}, sidecar ${sidecarVersion}, ${adapters.length} adapter(s))`,
        );
        // If a remote-triggered self-update was waiting for this
        // machine to come back on the new binary, fire `completed`
        // and resolve the bulk-loop promise.
        this.sidecarUpdate.observeMachineRegister(ev.machineId, sidecarVersion);
        await this.syncAgents(ev.machineId);
        break;
      }
      // 'machine-heartbeat' and 'heartbeat' never reach this switch —
      // processBatch coalesces them and applies the batched helpers
      // (applyMachineHeartbeat / applyAgentHeartbeats) directly.
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
        // Sidecar acked the destroy: the supervisor is torn down and the
        // machine-wide command reader has dropped this agent from its
        // snapshot, so a DEL now sticks — no self-heal can resurrect the
        // streams. This is the authoritative cleanup; destroyAgent's
        // earlier DEL covers the case where this ack never arrives.
        this.logger.log(`agent-destroyed ${ev.agentId} on ${ev.machineId}`);
        await this.deleteAgentStreams(ev.agentId);
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
        // Broadcast into the project room (Phase 2) + legacy agent room
        // so connected dashboards can invalidate their cached listings.
        this.gateway.emitFSChanged({
          agentId: ev.agentId,
          path: ev.path,
          machineId: ev.machineId,
          workingDir: ev.workingDir,
        });
        break;
      }
      case 'git-log-response': {
        // Same fan-in as fs-list-response — keyed by requestId in the
        // shared pending map.
        this.fs.handleGitLogResponse(ev);
        break;
      }
      case 'model-catalog-response': {
        // Same fan-in pattern — ModelsService resolves the pending
        // GET /agents/:id/models call (and populates its TTL cache).
        this.models.handleCatalogResponse(ev);
        break;
      }
      case 'git-changed': {
        // Debounced notification from the sidecar's secondary git
        // watcher (.git/HEAD + refs/heads/). Same project-room +
        // legacy agent-room fanout as fs-changed.
        this.gateway.emitGitChanged({
          agentId: ev.agentId,
          machineId: ev.machineId,
          workingDir: ev.workingDir,
        });
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

  /**
   * Persist quota rows the sidecar shipped on a machine-heartbeat.
   * Each row keys on (machineId, agentType, fingerprint) so the same
   * Anthropic/ChatGPT/Cursor account reported by multiple machines
   * dedupes naturally at aggregation time.
   *
   * Per-machine invariant: at most one fingerprint live per
   * (machineId, agentType). Without this, a logout (fingerprint='')
   * coexists in the table with the previous real row (fingerprint=
   * hash(account)) and `/me/quota` happily picks the still-fresh
   * real row, defeating the whole point of the tombstone. So before
   * upserting, we delete any other rows for this machine+type whose
   * fingerprint differs from the one we're about to write.
   *
   * Failures are swallowed and logged: heartbeat ingestion flips
   * Machine.status, and a quota write hiccup must never block that.
   */
  private async persistQuotas(machineId: string, quotas: AgentQuota[]) {
    for (const q of quotas) {
      const fingerprint = q.fingerprint ?? '';
      const data = {
        machineId,
        agentType: q.type,
        source: q.source,
        fingerprint,
        windows: (q.windows ?? []) as unknown as Prisma.InputJsonValue,
        error: q.error ?? null,
        checkedAt: new Date(q.checkedAt),
      };
      try {
        await this.prisma.$transaction([
          this.prisma.machineAgentQuota.deleteMany({
            where: {
              machineId,
              agentType: q.type,
              fingerprint: { not: fingerprint },
            },
          }),
          this.prisma.machineAgentQuota.upsert({
            where: {
              machineId_agentType_fingerprint: {
                machineId,
                agentType: q.type,
                fingerprint,
              },
            },
            create: data,
            update: data,
          }),
        ]);
      } catch (err) {
        this.logger.warn(
          `quota upsert failed for ${machineId}/${q.type}: ${(err as Error).message}`,
        );
      }
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
