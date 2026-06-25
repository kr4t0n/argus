import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { ApiKeyDTO, CreatedApiKey } from '@argus/shared-types';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../infra/prisma/prisma.service';

/** The acting user + flags resolved from a presented API-key secret. */
export interface VerifiedApiKey {
  id: string;
  readonly: boolean;
  user: { id: string; email: string; role: string };
}

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a key for `userId`. The plaintext secret is returned ONCE in `key`
   * and never persisted — only its SHA-256 hash is stored. Callers must
   * surface `key` to the user immediately; it is unrecoverable afterwards.
   */
  async mint(
    userId: string,
    name: string,
    opts?: { readonly?: boolean; expiresAt?: Date | null },
  ): Promise<CreatedApiKey> {
    const secret = `argus_${randomBytes(24).toString('base64url')}`;
    const rec = await this.prisma.apiKey.create({
      data: {
        userId,
        name,
        prefix: secret.slice(0, 12),
        hash: hashKey(secret),
        readonly: opts?.readonly ?? true,
        expiresAt: opts?.expiresAt ?? null,
      },
    });
    return { ...toSummary(rec), key: secret };
  }

  /** A user's active (non-revoked) keys, newest first. Never returns secrets. */
  async list(userId: string): Promise<ApiKeyDTO[]> {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toSummary);
  }

  /** Soft-revoke a key the user owns. Returns false if not found / not theirs. */
  async revoke(userId: string, id: string): Promise<boolean> {
    const res = await this.prisma.apiKey.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return res.count > 0;
  }

  /**
   * Resolve a presented secret to the user it authenticates as, or throw.
   * Rejects unknown, revoked, and expired keys. Bumps `lastUsedAt` on a
   * best-effort basis — a failed bump must never fail the request.
   */
  async verify(presented: string): Promise<VerifiedApiKey> {
    const rec = await this.prisma.apiKey.findUnique({
      where: { hash: hashKey(presented) },
      include: { user: true },
    });
    if (!rec || rec.revokedAt || (rec.expiresAt && rec.expiresAt.getTime() < Date.now())) {
      throw new UnauthorizedException('invalid api key');
    }
    void this.prisma.apiKey
      .update({ where: { id: rec.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      id: rec.id,
      readonly: rec.readonly,
      user: { id: rec.user.id, email: rec.user.email, role: rec.user.role },
    };
  }
}

function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function toSummary(rec: {
  id: string;
  name: string;
  prefix: string;
  readonly: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}): ApiKeyDTO {
  return {
    id: rec.id,
    name: rec.name,
    prefix: rec.prefix,
    readonly: rec.readonly,
    createdAt: rec.createdAt.toISOString(),
    lastUsedAt: rec.lastUsedAt ? rec.lastUsedAt.toISOString() : null,
    expiresAt: rec.expiresAt ? rec.expiresAt.toISOString() : null,
  };
}
