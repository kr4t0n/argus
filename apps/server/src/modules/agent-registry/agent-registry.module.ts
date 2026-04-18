import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { AgentRegistryController } from './agent-registry.controller';
import { AgentRegistryService } from './agent-registry.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule],
  providers: [AgentRegistryService],
  controllers: [AgentRegistryController],
  exports: [AgentRegistryService],
})
export class AgentRegistryModule {}
