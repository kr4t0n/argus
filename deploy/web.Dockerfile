# syntax=docker/dockerfile:1.7
# Multi-stage build for the Argus React/Vite web app.
#
# We deliberately do NOT bake VITE_API_URL / VITE_WS_URL into the
# bundle: the runtime helper in `apps/web/src/lib/host.ts` derives the
# server URL from `window.location.hostname` at load time, so the same
# image works whether you reach it as `localhost`, `192.168.1.10`, or a
# public hostname. Override the env vars at build time only if you want
# to point the bundle at a fixed remote API.

# ── Stage 1: install deps ─────────────────────────────────────────────
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared-types/package.json ./packages/shared-types/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: build the SPA ────────────────────────────────────────────
FROM deps AS builder
COPY packages/shared-types ./packages/shared-types
COPY apps/web ./apps/web

# Build args are passed through Vite's `import.meta.env.VITE_*`. Empty
# strings keep host.ts on the auto-derive path.
ARG VITE_API_URL=""
ARG VITE_WS_URL=""
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL

RUN pnpm --filter @argus/shared-types build \
 && pnpm --filter @argus/web build

# ── Stage 3: nginx static-serve ───────────────────────────────────────
FROM nginx:alpine AS runtime
COPY deploy/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80
