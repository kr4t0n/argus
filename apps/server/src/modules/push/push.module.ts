import { Module } from '@nestjs/common';
import { DeviceController } from './device.controller';
import { PushService } from './push.service';

@Module({
  controllers: [DeviceController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
