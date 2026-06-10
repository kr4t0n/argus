import { forwardRef, Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { SessionModule } from '../session/session.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { CommandController } from './command.controller';
import { CommandService } from './command.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule, forwardRef(() => SessionModule), AttachmentModule],
  providers: [CommandService],
  controllers: [CommandController],
  exports: [CommandService],
})
export class CommandModule {}
