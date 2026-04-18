import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async validate(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('invalid credentials');
    return user;
  }

  async login(email: string, password: string) {
    const user = await this.validate(email, password);
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const token = await this.jwt.signAsync(payload);
    return {
      token,
      user: { id: user.id, email: user.email, role: user.role as 'admin' | 'viewer' },
    };
  }

  async findUser(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
