import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { UserBootstrap } from './user.bootstrap';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      // JWT_EXPIRES_IN accepts any `ms` string ("7d", "24h", "30m").
      // Set it to "never" (or leave empty) to mint non-expiring tokens —
      // useful for long-lived terminal sessions where a mid-session
      // re-login would kill the PTY. Non-expiring tokens skip the `exp`
      // claim entirely, so passport-jwt's expiration check is a no-op.
      useFactory: (config: ConfigService) => {
        const raw = config.get<string>('JWT_EXPIRES_IN', '7d').trim();
        const expiresIn = raw === '' || raw.toLowerCase() === 'never' ? undefined : raw;
        return {
          secret: config.get<string>('JWT_SECRET', 'dev-only-change-me'),
          signOptions: expiresIn ? { expiresIn } : {},
        };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [AuthService, JwtStrategy, UserBootstrap],
  controllers: [AuthController],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
