import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StreamGateway } from './stream.gateway';

@Global()
@Module({
  imports: [AuthModule],
  providers: [StreamGateway],
  exports: [StreamGateway],
})
export class GatewayModule {}
