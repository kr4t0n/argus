import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [AuthModule],
  providers: [SearchService],
  controllers: [SearchController],
  exports: [SearchService],
})
export class SearchModule {}
