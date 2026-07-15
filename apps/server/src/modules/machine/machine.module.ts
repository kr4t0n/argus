import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { BackgroundTaskController } from './background-task.controller';
import { BackgroundTaskService } from './background-task.service';
import { ProjectFSController } from './fs.controller';
import { FSService } from './fs.service';
import { ProjectGitController } from './git.controller';
import { MachineController } from './machine.controller';
import { MachineModelsController } from './models.controller';
import { ModelsService } from './models.service';
import { MachineService } from './machine.service';
import { SidecarUpdateService } from './sidecar-update.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule],
  providers: [MachineService, FSService, ModelsService, SidecarUpdateService, BackgroundTaskService],
  controllers: [
    MachineController,
    ProjectFSController,
    ProjectGitController,
    MachineModelsController,
    BackgroundTaskController,
  ],
  exports: [MachineService, FSService, ModelsService, SidecarUpdateService, BackgroundTaskService],
})
export class MachineModule {}
