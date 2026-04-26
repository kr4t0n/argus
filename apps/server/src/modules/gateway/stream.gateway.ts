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
  AgentDTO,
  CommandDTO,
  MachineDTO,
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

  @SubscribeMessage('subscribe:agent')
  subAgent(@ConnectedSocket() c: Socket, @MessageBody() agentId: string) {
    c.join(`agent:${agentId}`);
  }

  @SubscribeMessage('unsubscribe:agent')
  unsubAgent(@ConnectedSocket() c: Socket, @MessageBody() agentId: string) {
    c.leave(`agent:${agentId}`);
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

  // ------- Broadcast helpers (called from other services) -------

  emitAgentUpsert(agent: AgentDTO) {
    this.server.emit('agent:upsert', agent);
  }

  emitAgentStatus(id: string, status: AgentDTO['status']) {
    this.server.emit('agent:status', { id, status });
  }

  emitAgentRemoved(id: string) {
    this.server.emit('agent:removed', { id });
  }

  emitAgentSpawnFailed(payload: { machineId: string; agentId: string; reason: string }) {
    this.server.emit('agent:spawn-failed', payload);
  }

  emitMachineUpsert(machine: MachineDTO) {
    this.server.emit('machine:upsert', machine);
  }

  emitMachineStatus(id: string, status: MachineDTO['status']) {
    this.server.emit('machine:status', { id, status });
  }

  emitMachineRemoved(id: string) {
    this.server.emit('machine:removed', { id });
  }

  emitSessionCreated(session: SessionDTO) {
    this.server.to(`user:${session.userId}`).emit('session:created', session);
  }

  emitSessionUpdated(session: SessionDTO) {
    this.server.to(`user:${session.userId}`).emit('session:updated', session);
  }

  emitSessionStatus(session: SessionDTO) {
    this.server
      .to(`user:${session.userId}`)
      .emit('session:status', { id: session.id, status: session.status });
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
   * Broadcast a dir-level change from the sidecar's fsnotify watcher.
   * Scoped to the agent room so only clients actually viewing that
   * agent's file tree get poked.
   */
  emitFSChanged(payload: { agentId: string; path: string }) {
    this.server.to(`agent:${payload.agentId}`).emit('fs:changed', payload);
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
}
