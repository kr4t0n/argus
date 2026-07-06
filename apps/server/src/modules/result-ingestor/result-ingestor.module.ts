import { Module } from '@nestjs/common';
import { CommandModule } from '../command/command.module';
import { GatewayModule } from '../gateway/gateway.module';
import { PushModule } from '../push/push.module';
import { SessionModule } from '../session/session.module';
import { ResultIngestorService } from './result-ingestor.service';

@Module({
  imports: [GatewayModule, SessionModule, CommandModule, PushModule],
  providers: [ResultIngestorService],
})
export class ResultIngestorModule {}
