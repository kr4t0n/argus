import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { FSController } from './fs.controller';
import { FSService } from './fs.service';
import { MachineController } from './machine.controller';
import { MachineService } from './machine.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule],
  providers: [MachineService, FSService],
  controllers: [MachineController, FSController],
  exports: [MachineService, FSService],
})
export class MachineModule {}
