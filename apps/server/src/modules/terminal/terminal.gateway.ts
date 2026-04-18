import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import {
  WS_NAMESPACE,
  type TerminalInputMessage,
  type TerminalResizeMessage,
} from '@argus/shared-types';
import { TerminalService } from './terminal.service';

/**
 * Receives terminal input/resize/close from the browser. We piggy-back
 * on the same socket.io namespace as StreamGateway so the same
 * authenticated client can also subscribe to terminal output rooms.
 *
 * Auth is established by StreamGateway.handleConnection, which sets
 * client.data.userId. We require it here.
 */
@WebSocketGateway({
  namespace: WS_NAMESPACE,
  cors: { origin: true, credentials: true },
})
export class TerminalGateway {
  private readonly logger = new Logger(TerminalGateway.name);

  constructor(private readonly terminals: TerminalService) {}

  @SubscribeMessage('terminal:input')
  async input(
    @ConnectedSocket() c: Socket,
    @MessageBody() msg: TerminalInputMessage,
  ): Promise<void> {
    const userId = c.data?.userId as string | undefined;
    if (!userId || !msg?.terminalId || typeof msg.data !== 'string') return;
    try {
      await this.terminals.input(userId, msg);
    } catch (err) {
      this.logger.warn(`input error: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('terminal:resize')
  async resize(
    @ConnectedSocket() c: Socket,
    @MessageBody() msg: TerminalResizeMessage,
  ): Promise<void> {
    const userId = c.data?.userId as string | undefined;
    if (!userId || !msg?.terminalId) return;
    try {
      await this.terminals.resize(userId, msg);
    } catch (err) {
      this.logger.warn(`resize error: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('terminal:close')
  async close(
    @ConnectedSocket() c: Socket,
    @MessageBody() id: string,
  ): Promise<void> {
    const userId = c.data?.userId as string | undefined;
    if (!userId || !id) return;
    try {
      await this.terminals.close(userId, id);
    } catch (err) {
      this.logger.warn(`close error: ${(err as Error).message}`);
    }
  }
}
