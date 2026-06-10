import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { BackgroundTasksResponse } from '@argus/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BackgroundTaskService } from './background-task.service';

/**
 * REST face onto the in-memory background-task registry. Used by the
 * dashboard's Progress tab on mount so a tab opened mid-run hydrates
 * with the current state instead of waiting for the next live socket
 * event. After mount the tab subscribes to `subscribe:project` and
 * stays in sync via gateway broadcasts.
 *
 * Project identity is the `(machineId, workingDir)` pair every session
 * in that directory shares; workingDir rides as a query param because
 * it's an absolute path and doesn't fit cleanly in a URL segment
 * (mirrors how `/me/project-notes` works).
 */
@UseGuards(JwtAuthGuard)
@Controller('machines')
export class BackgroundTaskController {
  constructor(private readonly tasks: BackgroundTaskService) {}

  @Get(':machineId/background-tasks')
  list(
    @Param('machineId') machineId: string,
    @Query('workingDir') workingDir: string,
  ): BackgroundTasksResponse {
    if (!workingDir) {
      throw new BadRequestException('workingDir is required');
    }
    return { tasks: this.tasks.listForProject(machineId, workingDir) };
  }

  /**
   * Dismiss one background task — remove it from the in-memory
   * registry and broadcast the removal so every subscribed dashboard
   * drops the card. Effect is global, not per-user (matches how the
   * old wall-clock eviction worked). Idempotent at the data layer
   * but returns 404 for unknown taskIds so a stale double-click
   * doesn't silently look successful.
   */
  @Delete(':machineId/background-tasks/:taskId')
  @HttpCode(204)
  dismiss(
    @Param('machineId') machineId: string,
    @Param('taskId') taskId: string,
    @Query('workingDir') workingDir: string,
  ): void {
    if (!workingDir) {
      throw new BadRequestException('workingDir is required');
    }
    if (!this.tasks.dismissTask(machineId, workingDir, taskId)) {
      throw new NotFoundException('task not found');
    }
  }
}
