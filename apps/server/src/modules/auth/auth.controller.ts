import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { ApiKeyService } from './api-key.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

type AuthedRequest = Request & {
  user: { id: string; email: string; role: string };
  apiKey?: { id: string; readonly: boolean };
};

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/** POST /auth/api-keys body. `readonly` defaults to true server-side. */
class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsBoolean()
  readonly?: boolean;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  @Post('login')
  async login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: AuthedRequest) {
    return { user: req.user };
  }

  // --- API key management -------------------------------------------------
  // Minting/listing/revoking is restricted to a logged-in human (a JWT
  // session) via requireHuman(): an API key must never manage API keys, or a
  // leaked key could mint fresh ones and outlive its own revocation. (For
  // POST/DELETE a read-only key is already blocked by the guard's method
  // check; the GET list is the case requireHuman() really guards.)

  @UseGuards(JwtAuthGuard)
  @Post('api-keys')
  async createApiKey(@Req() req: AuthedRequest, @Body() body: CreateApiKeyDto) {
    requireHuman(req);
    // The returned `key` is the plaintext secret — shown once, never stored.
    return this.apiKeys.mint(req.user.id, body.name, { readonly: body.readonly ?? true });
  }

  @UseGuards(JwtAuthGuard)
  @Get('api-keys')
  async listApiKeys(@Req() req: AuthedRequest) {
    requireHuman(req);
    return this.apiKeys.list(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('api-keys/:id')
  async revokeApiKey(@Req() req: AuthedRequest, @Param('id') id: string) {
    requireHuman(req);
    const ok = await this.apiKeys.revoke(req.user.id, id);
    if (!ok) throw new NotFoundException('api key not found');
    return { revoked: true };
  }
}

function requireHuman(req: AuthedRequest): void {
  if (req.apiKey) throw new ForbiddenException('api keys cannot manage api keys');
}
