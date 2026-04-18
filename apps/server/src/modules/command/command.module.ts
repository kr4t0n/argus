import { forwardRef, Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { SessionModule } from '../session/session.module';
import { CommandController } from './command.controller';
import { CommandService } from './command.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule, forwardRef(() => SessionModule)],
  providers: [CommandService],
  controllers: [CommandController],
  exports: [CommandService],
})
export class CommandModule {}
