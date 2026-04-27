import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { FSController } from './fs.controller';
import { FSService } from './fs.service';
import { GitController } from './git.controller';
import { MachineController } from './machine.controller';
import { MachineService } from './machine.service';
import { SidecarUpdateService } from './sidecar-update.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule],
  providers: [MachineService, FSService, SidecarUpdateService],
  controllers: [MachineController, FSController, GitController],
  exports: [MachineService, FSService, SidecarUpdateService],
})
export class MachineModule {}
