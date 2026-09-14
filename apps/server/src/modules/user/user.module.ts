import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PixelsController } from './pixels.controller';
import { PixelsService } from './pixels.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  imports: [AuthModule],
  providers: [UserService, PixelsService],
  controllers: [UserController, PixelsController],
})
export class UserModule {}
