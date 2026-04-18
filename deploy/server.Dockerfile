# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:20-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

COPY packages/shared-types packages/shared-types
COPY apps/server apps/server

RUN pnpm --filter @argus/server exec prisma generate
RUN pnpm --filter @argus/server build

# ---------- runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl ca-certificates && corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY --from=builder /repo/apps/server/dist ./apps/server/dist
COPY --from=builder /repo/apps/server/prisma ./apps/server/prisma
COPY --from=builder /repo/apps/server/package.json ./apps/server/package.json
COPY --from=builder /repo/packages/shared-types ./packages/shared-types
COPY --from=builder /repo/package.json ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /repo/.npmrc ./.npmrc

RUN pnpm install --prod --no-frozen-lockfile
RUN pnpm --filter @argus/server exec prisma generate

WORKDIR /app/apps/server
EXPOSE 4000
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
