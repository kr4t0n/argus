import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type {
  BackgroundTaskDTO,
  BackgroundTaskEndedEvent,
  BackgroundTaskEvent,
  BackgroundTaskProgressEvent,
  BackgroundTaskStartedEvent,
} from '@argus/shared-types';
import { consumerGroups, streamKeys } from '@argus/shared-types';
import { RedisService } from '../../infra/redis/redis.service';
import { StreamGateway } from '../gateway/stream.gateway';

/** Consumer name inside `consumerGroups.background`. Unique per-replica
 *  when we eventually scale out; for now one server, one consumer. */
const CONSUMER = 'server-1';

/**
 * How long the in-memory "dismissed" tombstone lingers after a user
 * clicks the X on a card. Within this window, any further events for
 * the same taskId are silently dropped — otherwise a still-alive
 * argus-bg's next progress frame would just re-upsert the row and the
 * card would pop back in, undoing the dismiss. 10 minutes is plenty
 * for the common case (sidecar restart re-tails the JSONL on disk and
 * replays a few seconds of events) without growing the set unbounded.
 */
const DISMISSED_TTL_MS = 10 * 60_000;

/**
 * In-memory registry of every active-or-recently-ended background
 * task, keyed by (machineId, workingDir, taskId). Populated by this
 * service's own consumer loop on the dedicated
 * `streamKeys.background` Redis stream — kept off `agent:lifecycle`
 * so chatty tqdm bars can't trim heartbeats / fs-changed / etc. out
 * of the shared stream via MAXLEN, and so the lifecycle consumer
 * doesn't have to walk past every progress frame to find its work.
 *
 * Single source of truth for both the REST late-join endpoint
 * (`GET /machines/:id/background-tasks?workingDir=...`) and the live
 * gateway broadcasts. No DB persistence — the JSONL files on the
 * agent's disk are authoritative if you need history.
 */
@Injectable()
export class BackgroundTaskService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackgroundTaskService.name);

  // machineId → workingDir → taskId → DTO
  private readonly state = new Map<string, Map<string, Map<string, BackgroundTaskDTO>>>();
  // dismissed (machineId|workingDir|taskId) → unix ms. Lazily expired
  // by isDismissed() — a check that's already on the hot path of every
  // ingested event, so no separate GC ticker is needed.
  private readonly dismissed = new Map<string, number>();

  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly redis: RedisService,
    private readonly gateway: StreamGateway,
  ) {}

  async onModuleInit() {
    await this.redis.ensureGroup(streamKeys.background, consumerGroups.background);
    this.running = true;
    this.loopPromise = this.consumeLoop();
  }

  async onModuleDestroy() {
    this.running = false;
    // Match MachineService's 6s grace window — the BLOCK timeout
    // inside the loop is 5s, so this gives one full block-cycle to
    // notice `this.running` flipped and exit cleanly.
    await Promise.race([this.loopPromise, new Promise((r) => setTimeout(r, 6_000))]);
  }

  /**
   * XREADGROUP loop on the dedicated background-task stream. Mirrors
   * the shape of MachineService.consumeLoop — same batch size, same
   * 5s BLOCK — but runs as its own coroutine so a heavy heartbeat
   * sweep on the lifecycle consumer can't stall progress ingest, and
   * vice versa.
   */
  private async consumeLoop() {
    while (this.running) {
      try {
        const res = (await this.redis.read.xreadgroup(
          'GROUP',
          consumerGroups.background,
          CONSUMER,
          'COUNT',
          50,
          'BLOCK',
          5_000,
          'STREAMS',
          streamKeys.background,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) continue;
        for (const [, entries] of res) {
          for (const [msgId, fields] of entries) {
            try {
              const data = parseData(fields);
              if (data) this.handle(data as BackgroundTaskEvent);
            } catch (err) {
              this.logger.error(`failed to handle bg-task event: ${(err as Error).message}`);
            }
            await this.redis.cmd.xack(streamKeys.background, consumerGroups.background, msgId);
          }
        }
      } catch (err) {
        if (this.running) {
          this.logger.error(`background-task loop error: ${(err as Error).message}`);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  private handle(ev: BackgroundTaskEvent) {
    switch (ev.kind) {
      case 'background-task-started':
        this.handleStarted(ev);
        break;
      case 'background-task-progress':
        this.handleProgress(ev);
        break;
      case 'background-task-ended':
        this.handleEnded(ev);
        break;
    }
  }

  handleStarted(ev: BackgroundTaskStartedEvent) {
    if (this.isDismissed(ev.machineId, ev.workingDir, ev.taskId)) return;
    const dto: BackgroundTaskDTO = {
      taskId: ev.taskId,
      machineId: ev.machineId,
      workingDir: ev.workingDir,
      agentId: ev.agentId,
      label: ev.label,
      cmd: ev.cmd,
      startedAt: ev.startedAt,
      ts: ev.ts,
    };
    this.upsert(dto);
    this.gateway.emitBackgroundTaskUpdated(dto);
  }

  handleProgress(ev: BackgroundTaskProgressEvent) {
    if (this.isDismissed(ev.machineId, ev.workingDir, ev.taskId)) return;
    const existing = this.find(ev.machineId, ev.workingDir, ev.taskId);
    // No `start` seen yet (sidecar restarted mid-task, or the start
    // line was lost): synthesize a minimal record so the UI still
    // gets a row. argus-bg always writes `start` first, so this is
    // best-effort recovery rather than the common path.
    const next: BackgroundTaskDTO = existing
      ? { ...existing }
      : {
          taskId: ev.taskId,
          machineId: ev.machineId,
          workingDir: ev.workingDir,
          agentId: ev.agentId,
          startedAt: ev.ts,
          ts: ev.ts,
        };
    next.current = ev.current;
    next.total = ev.total;
    next.percent = ev.percent;
    next.etaSeconds = ev.etaSeconds;
    next.rate = ev.rate;
    next.unit = ev.unit;
    next.desc = ev.desc;
    next.ts = ev.ts;
    this.upsert(next);
    this.gateway.emitBackgroundTaskUpdated(next);
  }

  handleEnded(ev: BackgroundTaskEndedEvent) {
    if (this.isDismissed(ev.machineId, ev.workingDir, ev.taskId)) return;
    const existing = this.find(ev.machineId, ev.workingDir, ev.taskId);
    const next: BackgroundTaskDTO = existing
      ? { ...existing }
      : {
          taskId: ev.taskId,
          machineId: ev.machineId,
          workingDir: ev.workingDir,
          agentId: ev.agentId,
          startedAt: ev.ts,
          ts: ev.ts,
        };
    next.endedAt = ev.endedAt;
    next.exitCode = ev.exitCode;
    next.status = ev.status;
    next.ts = ev.ts;
    this.upsert(next);
    this.gateway.emitBackgroundTaskUpdated(next);
    // Ended tasks linger in memory until a user explicitly dismisses
    // them via `dismissTask` — no wall-clock auto-eviction. The
    // dashboard shows an X button on ended cards so the user controls
    // when the row drops.
  }

  /**
   * Remove a task from the in-memory registry and broadcast the
   * removal so every subscribed dashboard drops it from its list.
   * Returns false if there was no such task — surfaced as a 404 by
   * the controller so a stale double-click doesn't appear successful.
   *
   * Works for cards in any state, including still-running. The main
   * use case is recovering from a crashed `argus-bg` (e.g. OOM kill)
   * where the wrapper never wrote its `end` event — the card would
   * otherwise be stuck mid-progress forever.
   *
   * Records a dismissed tombstone (`DISMISSED_TTL_MS`) so any later
   * events for the same taskId — from a still-alive argus-bg, or
   * from the sidecar re-tailing the JSONL after a restart — get
   * silently dropped instead of resurrecting the card.
   *
   * Dismissal is global, not per-user — every dashboard viewing this
   * project sees the card disappear. Per-user "hide for me" would
   * need DB state.
   */
  dismissTask(machineId: string, workingDir: string, taskId: string): boolean {
    const tasks = this.state.get(machineId)?.get(workingDir);
    if (!tasks || !tasks.delete(taskId)) {
      return false;
    }
    // Compact empty maps so memory doesn't drift when a project's
    // last task is dismissed.
    if (tasks.size === 0) {
      this.state.get(machineId)?.delete(workingDir);
    }
    if (this.state.get(machineId)?.size === 0) {
      this.state.delete(machineId);
    }
    this.dismissed.set(dismissalKey(machineId, workingDir, taskId), Date.now());
    this.gateway.emitBackgroundTaskRemoved({ machineId, workingDir, taskId });
    return true;
  }

  /**
   * Was this taskId dismissed within DISMISSED_TTL_MS? Lazy expiry:
   * stale entries are cleared on the same lookup that finds them,
   * so the dismissed map stays bounded by recent activity without
   * needing a separate timer.
   */
  private isDismissed(machineId: string, workingDir: string, taskId: string): boolean {
    const key = dismissalKey(machineId, workingDir, taskId);
    const ts = this.dismissed.get(key);
    if (ts === undefined) return false;
    if (Date.now() - ts > DISMISSED_TTL_MS) {
      this.dismissed.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Active + recently-ended tasks for one project — what a dashboard
   * GETs on mount to hydrate the Progress tab before the live socket
   * has caught up. Sorted by startedAt descending so newest tasks
   * float to the top of the list.
   */
  listForProject(machineId: string, workingDir: string): BackgroundTaskDTO[] {
    const projects = this.state.get(machineId);
    if (!projects) return [];
    const tasks = projects.get(workingDir);
    if (!tasks) return [];
    return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private upsert(dto: BackgroundTaskDTO) {
    let projects = this.state.get(dto.machineId);
    if (!projects) {
      projects = new Map();
      this.state.set(dto.machineId, projects);
    }
    let tasks = projects.get(dto.workingDir);
    if (!tasks) {
      tasks = new Map();
      projects.set(dto.workingDir, tasks);
    }
    tasks.set(dto.taskId, dto);
  }

  private find(
    machineId: string,
    workingDir: string,
    taskId: string,
  ): BackgroundTaskDTO | undefined {
    return this.state.get(machineId)?.get(workingDir)?.get(taskId);
  }
}

function dismissalKey(machineId: string, workingDir: string, taskId: string): string {
  return `${machineId}\x00${workingDir}\x00${taskId}`;
}

/** Decode the JSON payload XADD'd by the sidecar's bus.Publish. Same
 *  shape MachineService.parseData uses on the lifecycle stream:
 *  fields is a flat `[k1, v1, k2, v2, ...]` array, the `data` slot
 *  carries the JSON-encoded event. */
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
