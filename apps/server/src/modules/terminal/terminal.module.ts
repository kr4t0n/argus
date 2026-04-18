import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { TerminalController } from './terminal.controller';
import { TerminalGateway } from './terminal.gateway';
import { TerminalOutputConsumer } from './terminal-output.consumer';
import { TerminalService } from './terminal.service';

@Module({
  imports: [AuthModule, GatewayModule],
  providers: [TerminalService, TerminalGateway, TerminalOutputConsumer],
  controllers: [TerminalController],
  exports: [TerminalService],
})
export class TerminalModule {}
