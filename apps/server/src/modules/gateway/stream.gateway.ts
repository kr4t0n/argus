import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import type {
  BackgroundTaskDTO,
  CommandDTO,
  MachineDTO,
  ProjectDTO,
  ResultChunkDTO,
  SessionDTO,
  SidecarUpdatePlanEntry,
  TerminalDTO,
  TerminalOutputMessage,
  TerminalClosedMessage,
} from '@argus/shared-types';
import { WS_NAMESPACE } from '@argus/shared-types';

@WebSocketGateway({
  namespace: WS_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class StreamGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StreamGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: Socket) {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') as string | undefined);

    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = this.jwt.verify<{ sub: string }>(token);
      client.data.userId = payload.sub;
      client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect(true);
      return;
    }
    this.logger.debug(`client connected user=${client.data.userId} sid=${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`client disconnected sid=${client.id}`);
  }

  @SubscribeMessage('subscribe:session')
  subSession(@ConnectedSocket() c: Socket, @MessageBody() sessionId: string) {
    c.join(`session:${sessionId}`);
  }

  @SubscribeMessage('unsubscribe:session')
  unsubSession(@ConnectedSocket() c: Socket, @MessageBody() sessionId: string) {
    c.leave(`session:${sessionId}`);
  }

  @SubscribeMessage('subscribe:terminal')
  subTerminal(@ConnectedSocket() c: Socket, @MessageBody() terminalId: string) {
    c.join(`terminal:${terminalId}`);
  }

  @SubscribeMessage('unsubscribe:terminal')
  unsubTerminal(@ConnectedSocket() c: Socket, @MessageBody() terminalId: string) {
    c.leave(`terminal:${terminalId}`);
  }

  /**
   * Subscribe to project-scoped events (currently: background-task
   * progress). A project is identified by its `(machineId, workingDir)`
   * pair, the same key used by notes and the dashboard's per-project
   * panes. workingDir is an arbitrary string (absolute path) — Socket.IO
   * room names don't care, so we just concatenate.
   */
  @SubscribeMessage('subscribe:project')
  subProject(
    @ConnectedSocket() c: Socket,
    @MessageBody() body: { machineId: string; workingDir: string },
  ) {
    if (!body?.machineId || !body?.workingDir) return;
    c.join(projectRoom(body.machineId, body.workingDir));
  }

  @SubscribeMessage('unsubscribe:project')
  unsubProject(
    @ConnectedSocket() c: Socket,
    @MessageBody() body: { machineId: string; workingDir: string },
  ) {
    if (!body?.machineId || !body?.workingDir) return;
    c.leave(projectRoom(body.machineId, body.workingDir));
  }

  // ------- Broadcast helpers (called from other services) -------

  emitMachineUpsert(machine: MachineDTO) {
    this.server.emit('machine:upsert', machine);
  }

  emitMachineStatus(id: string, status: MachineDTO['status']) {
    this.server.emit('machine:status', { id, status });
  }

  emitMachineRemoved(id: string) {
    this.server.emit('machine:removed', { id });
  }

  // Global like machine:upsert — project icons are workspace-shared
  // sidebar furniture, not scoped to a project room subscription.
  emitProjectUpsert(project: ProjectDTO) {
    this.server.emit('project:upsert', project);
  }

  emitSessionCreated(session: SessionDTO) {
    this.server.to(`user:${session.userId}`).emit('session:created', session);
  }

  emitSessionUpdated(session: SessionDTO) {
    this.server.to(`user:${session.userId}`).emit('session:updated', session);
  }

  emitSessionStatus(session: SessionDTO) {
    // Carry `unread` (the dot trigger) and `updatedAt` (the client's
    // monotonic ordering key) so a stale REST response can't resurrect
    // a status/unread the user already cleared.
    this.server.to(`user:${session.userId}`).emit('session:status', {
      id: session.id,
      status: session.status,
      unread: session.unread,
      updatedAt: session.updatedAt,
    });
  }

  emitSessionCloneFailed(payload: { sessionId: string; userId: string; reason: string }) {
    this.server
      .to(`user:${payload.userId}`)
      .emit('session:clone-failed', { sessionId: payload.sessionId, reason: payload.reason });
  }

  emitCommandCreated(command: CommandDTO) {
    this.server.to(`session:${command.sessionId}`).emit('command:created', command);
  }

  emitCommandUpdated(command: CommandDTO) {
    this.server.to(`session:${command.sessionId}`).emit('command:updated', command);
  }

  emitChunk(chunk: ResultChunkDTO) {
    this.server.to(`session:${chunk.sessionId}`).emit('chunk', chunk);
  }

  // ------- Terminal events -------

  emitTerminalCreated(terminal: TerminalDTO) {
    this.server.to(`user:${terminal.userId}`).emit('terminal:created', terminal);
  }

  emitTerminalUpdated(terminal: TerminalDTO) {
    this.server.to(`user:${terminal.userId}`).emit('terminal:updated', terminal);
    this.server.to(`terminal:${terminal.id}`).emit('terminal:updated', terminal);
  }

  emitTerminalOutput(msg: TerminalOutputMessage) {
    this.server.to(`terminal:${msg.terminalId}`).emit('terminal:output', msg);
  }

  emitTerminalClosed(msg: TerminalClosedMessage) {
    this.server.to(`terminal:${msg.terminalId}`).emit('terminal:closed', msg);
  }

  // ------- Filesystem events -------

  /**
   * Broadcast a dir-level change from the sidecar's fsnotify watcher to
   * the project room — nudges are project-scoped (two runners sharing a
   * workdir emit interchangeable ones). A runner event without
   * machineId/workingDir has nothing to route on and is dropped.
   */
  emitFSChanged(payload: { path: string; machineId?: string; workingDir?: string }) {
    if (payload.machineId && payload.workingDir) {
      this.server
        .to(projectRoom(payload.machineId, payload.workingDir))
        .emit('fs:changed', payload);
    }
  }

  /**
   * Broadcast a debounced ref-change from the sidecar's secondary git
   * watcher. Same project-room fanout as emitFSChanged.
   */
  emitGitChanged(payload: { machineId?: string; workingDir?: string }) {
    if (payload.machineId && payload.workingDir) {
      this.server
        .to(projectRoom(payload.machineId, payload.workingDir))
        .emit('git:changed', payload);
    }
  }

  // ------- Sidecar remote-update events -------
  //
  // Broadcast globally rather than scoping to a per-machine room: the
  // machines list, machine kebab menu, batch progress strip, and any
  // open machine detail pane all want the same event, and there's no
  // existing per-machine room to piggy-back on. The events are tiny
  // and infrequent (one update can take ~5–10s), so the fan-out cost
  // is negligible compared with terminal traffic.

  emitSidecarUpdateStarted(payload: { machineId: string; requestId: string; fromVersion: string }) {
    this.server.emit('sidecar-update:started', payload);
  }

  emitSidecarUpdateDownloaded(payload: {
    machineId: string;
    requestId: string;
    fromVersion: string;
    toVersion: string;
    restartMode: 'self' | 'supervisor' | 'manual';
  }) {
    this.server.emit('sidecar-update:downloaded', payload);
  }

  emitSidecarUpdateCompleted(payload: {
    machineId: string;
    requestId: string;
    fromVersion: string;
    toVersion: string;
  }) {
    this.server.emit('sidecar-update:completed', payload);
  }

  emitSidecarUpdateFailed(payload: {
    machineId: string;
    requestId: string;
    fromVersion: string;
    reason: string;
  }) {
    this.server.emit('sidecar-update:failed', payload);
  }

  emitSidecarUpdateBatchProgress(payload: { batchId: string; plan: SidecarUpdatePlanEntry[] }) {
    this.server.emit('sidecar-update:batch-progress', payload);
  }

  // ------- Background task events (per-project room) -------
  //
  // One DTO per upsert — the dashboard treats start / progress / end
  // events uniformly as "the row's latest state." When the server
  // evicts an ended task after its retention window, it emits a
  // separate `:removed` so the dashboard can drop it from the list.

  emitBackgroundTaskUpdated(task: BackgroundTaskDTO) {
    this.server
      .to(projectRoom(task.machineId, task.workingDir))
      .emit('background-task:updated', task);
  }

  emitBackgroundTaskRemoved(payload: { machineId: string; workingDir: string; taskId: string }) {
    this.server
      .to(projectRoom(payload.machineId, payload.workingDir))
      .emit('background-task:removed', payload);
  }
}

function projectRoom(machineId: string, workingDir: string): string {
  return `project:${machineId}:${workingDir}`;
}
