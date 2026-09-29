import { Module } from '@nestjs/common';
import { ApnsTransport } from './apns.transport';
import { DeviceController, LiveActivityController } from './device.controller';
import { FcmTransport } from './fcm.transport';
import { PushConfigController } from './push-config.controller';
import { PushService } from './push.service';

@Module({
  controllers: [DeviceController, LiveActivityController, PushConfigController],
  providers: [PushService, ApnsTransport, FcmTransport],
  exports: [PushService],
})
export class PushModule {}
