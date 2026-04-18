import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { SidecarLinkModule } from '../sidecar-link/sidecar-link.module';
import { TerminalController } from './terminal.controller';
import { TerminalGateway } from './terminal.gateway';
import { TerminalLinkBridge } from './terminal-link.bridge';
import { TerminalService } from './terminal.service';

@Module({
  imports: [AuthModule, GatewayModule, SidecarLinkModule],
  providers: [TerminalService, TerminalGateway, TerminalLinkBridge],
  controllers: [TerminalController],
  exports: [TerminalService],
})
export class TerminalModule {}
