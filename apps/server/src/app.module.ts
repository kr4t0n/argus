import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { AgentRegistryModule } from './modules/agent-registry/agent-registry.module';
import { MachineModule } from './modules/machine/machine.module';
import { SessionModule } from './modules/session/session.module';
import { CommandModule } from './modules/command/command.module';
import { ResultIngestorModule } from './modules/result-ingestor/result-ingestor.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { TerminalModule } from './modules/terminal/terminal.module';
import { SidecarLinkModule } from './modules/sidecar-link/sidecar-link.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Look for .env both in the package (apps/server) and at the repo
      // root, so `pnpm --filter @argus/server dev` picks up the
      // monorepo-wide secrets file.
      envFilePath: ['.env', '../../.env'],
    }),
    PrismaModule,
    RedisModule,
    AuthModule,
    MachineModule,
    AgentRegistryModule,
    SessionModule,
    CommandModule,
    ResultIngestorModule,
    GatewayModule,
    SidecarLinkModule,
    TerminalModule,
    UserModule,
  ],
})
export class AppModule {}
