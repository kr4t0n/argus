import { Module } from '@nestjs/common';
import { SidecarLinkService } from './sidecar-link.service';

@Module({
  providers: [SidecarLinkService],
  exports: [SidecarLinkService],
})
export class SidecarLinkModule {}
