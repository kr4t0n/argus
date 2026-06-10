import { forwardRef, Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommandModule } from '../command/command.module';
import { GatewayModule } from '../gateway/gateway.module';
import { AttachmentModule } from '../attachment/attachment.module';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule, forwardRef(() => CommandModule), AttachmentModule],
  providers: [SessionService],
  controllers: [SessionController],
  exports: [SessionService],
})
export class SessionModule {}
