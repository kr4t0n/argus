# syntax=docker/dockerfile:1.7
# Multi-stage build for the Argus NestJS control plane.
#
# Stage layout:
#   1. deps     — install full workspace deps once for cache reuse.
#   2. builder  — copy source, build shared-types, generate Prisma client,
#                 compile the NestJS server, then `pnpm deploy --prod`
#                 a self-contained pruned tree.
#   3. runtime  — minimal node:alpine that runs prisma migrate deploy at
#                 boot, then `node dist/main.js`.

# ── Stage 1: install deps ─────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN apk add --no-cache openssl
WORKDIR /repo

# Copy only manifests so the install layer is cached as long as no
# package.json / lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: build server + prune ─────────────────────────────────────
FROM deps AS builder
COPY packages/shared-types ./packages/shared-types
COPY apps/server ./apps/server

RUN pnpm --filter @argus/shared-types build \
 && pnpm --filter @argus/server exec prisma generate \
 && pnpm --filter @argus/server build

# `pnpm deploy --prod` materialises a self-contained directory with just
# the server's package.json + production node_modules (workspace deps
# resolved). `--legacy` keeps the deterministic structure expected by
# node's resolver (no virtual store).
RUN pnpm --filter @argus/server deploy --prod --legacy /deploy

# ── Stage 3: runtime ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
RUN apk add --no-cache openssl tini
WORKDIR /app
ENV NODE_ENV=production

# Copy the pruned package + node_modules from the builder.
COPY --from=builder /deploy ./
# Copy compiled server JS and the prisma schema (needed for `migrate deploy`).
COPY --from=builder /repo/apps/server/dist ./dist
COPY --from=builder /repo/apps/server/prisma ./prisma

# Re-run `prisma generate` against the pruned node_modules so the
# generated client lands at the path the runtime resolver will use.
RUN pnpm exec prisma generate --schema prisma/schema.prisma

EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
# Apply pending migrations on every boot (idempotent), then start.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy --schema prisma/schema.prisma && node dist/main.js"]
