import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { S3ClientProvider } from './s3.provider';

// AuthModule is imported for two things it exports: the JwtModule (so the
// service can sign/verify download tokens with JWT_SECRET) and the
// JwtAuthGuard's strategy (so the upload route's guard resolves).
@Module({
  imports: [AuthModule],
  controllers: [AttachmentController],
  providers: [AttachmentService, S3ClientProvider],
  exports: [AttachmentService],
})
export class AttachmentModule {}
