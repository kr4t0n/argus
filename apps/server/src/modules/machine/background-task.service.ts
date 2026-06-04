import { Injectable, Logger } from '@nestjs/common';
import type {
  BackgroundTaskDTO,
  BackgroundTaskEndedEvent,
  BackgroundTaskProgressEvent,
  BackgroundTaskStartedEvent,
} from '@argus/shared-types';
import { StreamGateway } from '../gateway/stream.gateway';

/**
 * After a task ends, the server keeps its final state in memory for
 * this long so a dashboard joining the project moments later still
 * sees the completion (and the user gets the "✓ done in 12s" pill
 * rather than an empty list).
 */
const ENDED_RETENTION_MS = 5 * 60_000;

/**
 * In-memory registry of every active-or-recently-ended background
 * task, keyed by (machineId, workingDir, taskId). Populated from the
 * three BackgroundTask* lifecycle events the sidecar forwards (which
 * in turn come from `argus-bg` JSONL files written to
 * `<workingDir>/.argus/progress/`).
 *
 * Single source of truth for both the REST late-join endpoint
 * (`GET /machines/:id/background-tasks?workingDir=...`) and the live
 * gateway broadcasts. No DB persistence — the JSONL files on the
 * agent's disk are authoritative if you need history.
 */
@Injectable()
export class BackgroundTaskService {
  private readonly logger = new Logger(BackgroundTaskService.name);

  // machineId → workingDir → taskId → DTO
  private readonly state = new Map<string, Map<string, Map<string, BackgroundTaskDTO>>>();
  // (machineId|workingDir|taskId) → eviction timer; cleared when the
  // task gets a new event before the timer fires.
  private readonly evictionTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly gateway: StreamGateway) {}

  handleStarted(ev: BackgroundTaskStartedEvent) {
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
    this.scheduleEviction(ev.machineId, ev.workingDir, ev.taskId);
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

    // Any new event resets the eviction timer for this task — even
    // for ended tasks, since we might get duplicate ends from the
    // watcher's catch-up re-scan after a sidecar restart.
    this.clearEviction(dto.machineId, dto.workingDir, dto.taskId);
  }

  private find(
    machineId: string,
    workingDir: string,
    taskId: string,
  ): BackgroundTaskDTO | undefined {
    return this.state.get(machineId)?.get(workingDir)?.get(taskId);
  }

  private scheduleEviction(machineId: string, workingDir: string, taskId: string) {
    const key = evictionKey(machineId, workingDir, taskId);
    this.clearEviction(machineId, workingDir, taskId);
    const t = setTimeout(() => {
      this.evictionTimers.delete(key);
      const tasks = this.state.get(machineId)?.get(workingDir);
      if (!tasks) return;
      if (tasks.delete(taskId)) {
        this.gateway.emitBackgroundTaskRemoved({ machineId, workingDir, taskId });
      }
      // Compact empty maps so memory doesn't leak when a project's
      // tasks all expire.
      if (tasks.size === 0) {
        this.state.get(machineId)?.delete(workingDir);
      }
      if (this.state.get(machineId)?.size === 0) {
        this.state.delete(machineId);
      }
    }, ENDED_RETENTION_MS);
    // `unref` so a pending eviction never holds the process open
    // during graceful shutdown. NestJS test runners care; production
    // doesn't.
    t.unref?.();
    this.evictionTimers.set(key, t);
  }

  private clearEviction(machineId: string, workingDir: string, taskId: string) {
    const key = evictionKey(machineId, workingDir, taskId);
    const existing = this.evictionTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.evictionTimers.delete(key);
    }
  }
}

function evictionKey(machineId: string, workingDir: string, taskId: string): string {
  return `${machineId}\x00${workingDir}\x00${taskId}`;
}
