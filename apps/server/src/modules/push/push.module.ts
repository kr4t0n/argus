import { Module } from '@nestjs/common';
import { DeviceController, LiveActivityController } from './device.controller';
import { PushService } from './push.service';

@Module({
  controllers: [DeviceController, LiveActivityController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
