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
  ResultChunkDTO,
  SessionDTO,
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

  // ------- Broadcast helpers (called from other services) -------

  emitAgentUpsert(agent: AgentDTO) {
    this.server.emit('agent:upsert', agent);
  }

  emitAgentStatus(id: string, status: AgentDTO['status']) {
    this.server.emit('agent:status', { id, status });
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

  emitCommandCreated(command: CommandDTO) {
    this.server.to(`session:${command.sessionId}`).emit('command:created', command);
  }

  emitCommandUpdated(command: CommandDTO) {
    this.server.to(`session:${command.sessionId}`).emit('command:updated', command);
  }

  emitChunk(chunk: ResultChunkDTO) {
    this.server.to(`session:${chunk.sessionId}`).emit('chunk', chunk);
  }
}
