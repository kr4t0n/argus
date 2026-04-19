import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayModule } from '../gateway/gateway.module';
import { MachineController } from './machine.controller';
import { MachineService } from './machine.service';

@Global()
@Module({
  imports: [AuthModule, GatewayModule],
  providers: [MachineService],
  controllers: [MachineController],
  exports: [MachineService],
})
export class MachineModule {}
