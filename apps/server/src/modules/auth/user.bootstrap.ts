import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../infra/prisma/prisma.service';

/**
 * Ensures a single admin user exists on boot so the first login works
 * without a manual seed step. Credentials are controlled by env vars.
 */
@Injectable()
export class UserBootstrap implements OnModuleInit {
  private readonly logger = new Logger(UserBootstrap.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const email = this.config.get<string>('ADMIN_EMAIL', 'admin@argus.local');
    const password = this.config.get<string>('ADMIN_PASSWORD', 'changeme');

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) return;

    const passwordHash = await bcrypt.hash(password, 10);
    await this.prisma.user.create({
      data: { email, passwordHash, role: 'admin' },
    });
    this.logger.log(`Bootstrapped admin ${email}`);
  }
}
