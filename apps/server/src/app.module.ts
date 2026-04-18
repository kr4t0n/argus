import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { AgentRegistryModule } from './modules/agent-registry/agent-registry.module';
import { SessionModule } from './modules/session/session.module';
import { CommandModule } from './modules/command/command.module';
import { ResultIngestorModule } from './modules/result-ingestor/result-ingestor.module';
import { GatewayModule } from './modules/gateway/gateway.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    AuthModule,
    AgentRegistryModule,
    SessionModule,
    CommandModule,
    ResultIngestorModule,
    GatewayModule,
  ],
})
export class AppModule {}
