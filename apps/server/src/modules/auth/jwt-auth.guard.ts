import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { ApiKeyService } from './api-key.service';

/** HTTP methods a read-only API key is permitted to use. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type AuthedRequest = Request & {
  user?: { id: string; email: string; role: string };
  apiKey?: { id: string; readonly: boolean };
};

/**
 * Authenticates a request via EITHER a JWT (Authorization: Bearer — the human
 * login path) OR an API key (X-API-Key header — the machine path). The name is
 * historical; it now guards both credential types.
 *
 * For API keys flagged `readonly`, any non-safe HTTP method is rejected with
 * 403. Argus has no route-level RBAC (the only authz beyond "valid credential"
 * is per-row ownership checks), so "read-only" is enforced here by HTTP method:
 * every mutation in the API is POST/PATCH/DELETE and every read is GET, so
 * confining a key to GET/HEAD/OPTIONS makes it read-only across the surface.
 *
 * On success `req.user` is populated identically to JwtStrategy.validate()
 * ({ id, email, role }) so every existing controller works unchanged. API-key
 * requests additionally carry `req.apiKey = { id, readonly }` (used by the
 * key-management routes to refuse keys-managing-keys).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements CanActivate {
  constructor(private readonly apiKeys: ApiKeyService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const presented = headerValue(req.headers['x-api-key']);
    if (presented) {
      const key = await this.apiKeys.verify(presented); // throws 401 if invalid
      if (key.readonly && !SAFE_METHODS.has(req.method)) {
        throw new ForbiddenException('read-only API key');
      }
      req.user = key.user;
      req.apiKey = { id: key.id, readonly: key.readonly };
      return true;
    }

    // No API key presented — fall back to the JWT bearer-token path, which
    // sets req.user from the validated token via the passport strategy.
    return (await super.canActivate(context)) as boolean;
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : (v ?? undefined);
}
