# Argus

A multi-machine **agent management dashboard**. Argus lets you talk to one or
more CLI agents — Claude Code, Codex, Cursor CLI, or your own — running on any
number of machines, and watch their answers stream back into a single
dashboard in real time.

```
┌────────┐  HTTPS+WS   ┌─────────────┐  Redis Streams  ┌──────────────┐  exec  ┌────────────┐
│  Web   │ ─────────▶ │   Server    │ ─────────────▶  │   Sidecar    │ ─────▶ │  CLI agent │
│ (React)│ ◀───────── │ (NestJS)    │ ◀─────────────  │   (Go)       │ ◀───── │            │
└────────┘            └─────────────┘                  └──────────────┘        └────────────┘
                            │
                            ▼
                       Postgres
```

The control plane never speaks to a CLI directly: every CLI is wrapped by a
small Go *sidecar* that translates the CLI's native streaming output into a
common `ResultChunk` format and pushes it onto Redis Streams. The server
relays chunks to the browser over Socket.IO so you get true token-level
streaming with reconnect-safe replay.

## Features

- **Streaming-first UI**: typewriter deltas, tool-call pills, stdout/stderr
blocks, auto-scroll-with-stickiness, replay-on-reconnect.
- **Multi-machine, multi-agent**: each sidecar has its own identity; agents
appear in the sidebar grouped by type with sessions nested under them.
- **Sessions = conversations**: long-lived chat threads tied to the CLI's
native `--resume` ids so you can pick up where you left off.
- **Pluggable adapters**: `claude-code`, `codex`, `cursor-cli` ship in the
box; new ones are ~30 lines + an `init()` register call.
- **Soft-archive everywhere**: hide a session or an entire agent from the
sidebar without losing history. The data stays in Postgres and can be
restored with one click; archived agents stay archived even if the
sidecar restarts.
- **Interactive terminal per agent (opt-in)**: when a sidecar enables
`terminal.enabled`, the dashboard's right panel grows a real PTY shell
on that machine — full ANSI colors, resize, ctrl-C, the works.
xterm.js on the front, `creack/pty` in the sidecar, multiplexed over
the same Redis bus. Treat opt-in as remote shell access: only enable
on hosts where every dashboard user is trusted to that level.
- **Redis Streams** for the bus: durable, replayable, no extra ops weight on
top of the Redis you already run.

## Repo layout

```
argus/
├── apps/
│   ├── web/                  Vite + React + TS + Tailwind + Zustand
│   └── server/               NestJS + Prisma + Socket.IO
├── packages/
│   ├── shared-types/         TS types shared by web + server
│   └── sidecar/              Go sidecar (single binary)
└── deploy/                   docker-compose + Dockerfiles + sample sidecar.yaml
```

## Prerequisites

- **Node.js** ≥ 20 and **pnpm** ≥ 10
- **Go** ≥ 1.23 (only needed if you build the sidecar locally)
- **Docker** + Docker Compose (only needed for the bundled local stack)
- **Postgres** 16+ and **Redis** 7+ if not using Compose
- A CLI agent on PATH for any sidecar you run locally
(`claude`, `codex`, or `cursor-agent`)

## Quick start

### 1. Bring up Postgres, Redis, server, and web

```bash
cp .env.example .env
docker compose -f deploy/docker-compose.yml up --build
```

The dashboard is at [http://localhost:5173](http://localhost:5173). Sign in with the seeded admin
credentials (`admin@argus.local` / `changeme` by default — change them in
`.env`).

### 2. Build and run a sidecar

The sidecar is **not** part of compose on purpose: you run it on whatever
machine actually has the CLI you want to expose.

```bash
# Build the binary
cd packages/sidecar && go build -o bin/sidecar ./cmd/sidecar

# Edit a config (one per machine/adapter)
cp ../../deploy/sidecar.claude.example.yaml ./sidecar.yaml

# Run it
./bin/sidecar --config sidecar.yaml
```

Once the sidecar registers you'll see it appear in the dashboard's sidebar.
Click `+ new session` under it to start a streaming chat.

Set `workingDir:` in `sidecar.yaml` to control the directory the wrapped CLI
runs in — all of the agent's file reads/edits and shell commands resolve
relative to it. Supports `~` and `${ENV}` expansion; the path must exist.
The dashboard shows the active working dir in the Agent context pane.

#### Optional: enable the interactive terminal

Add this stanza to a sidecar's YAML to expose a PTY in the right-side
panel of the dashboard:

```yaml
terminal:
  enabled: true
  shells: ["/bin/zsh", "/bin/bash", "/bin/sh"]
  # defaultShell: /bin/zsh   # optional; falls back to $SHELL ∩ shells, then shells[0]
  # maxSessions: 5           # cap concurrent PTYs per sidecar
  # cwd: ~/work              # defaults to workingDir
```

> **Security**: this gives every dashboard user shell-as-sidecar-user on
> this host. Only enable on machines where that's an acceptable trust
> model. The sidecar enforces a `shells` allowlist and a session cap;
> the server scopes terminals to the opening user; every open/close is
> recorded in the `Terminal` table for audit. Transcripts are **not**
> persisted by design.

### 3. Local development without Docker

```bash
# Install once
pnpm install

# Bring up only the data plane
docker compose -f deploy/docker-compose.yml up postgres redis -d

# Server (NestJS, watch mode)
pnpm --filter @argus/server exec prisma migrate dev
pnpm --filter @argus/server dev

# Web (Vite)
pnpm --filter @argus/web dev

# Sidecar
cd packages/sidecar && go run ./cmd/sidecar --config ../../deploy/sidecar.claude.example.yaml
```

## Common tasks


| What you want                       | Command                                               |
| ----------------------------------- | ----------------------------------------------------- |
| Typecheck everything                | `pnpm typecheck`                                      |
| Build everything                    | `pnpm build`                                          |
| Apply a Prisma migration            | `pnpm --filter @argus/server exec prisma migrate dev` |
| Re-seed the admin user              | `pnpm --filter @argus/server seed`                    |
| List adapters compiled into sidecar | `./packages/sidecar/bin/sidecar --list-adapters`      |
| Open Prisma Studio                  | `pnpm --filter @argus/server exec prisma studio`      |


## Environment variables

See `[.env.example](./.env.example)` for the full list. Highlights:


| Variable               | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `DATABASE_URL`         | Postgres connection string used by Prisma               |
| `REDIS_URL`            | Redis connection string used by server **and** sidecars |
| `JWT_SECRET`           | HMAC secret for auth tokens                             |
| `ADMIN_EMAIL/PASSWORD` | Bootstrapped admin credentials                          |
| `VITE_API_URL`         | URL the web app uses for REST calls                     |
| `VITE_WS_URL`          | URL the web app uses for Socket.IO                      |


## Adding a custom CLI agent

1. Create `packages/sidecar/internal/adapter/myagent.go`.
2. Implement the `Adapter` interface (usually 20–40 lines — reuse `clistream.Start`).
3. Call `adapter.Register("my-agent", newMyAgent)` from `init()`.
4. Rebuild the sidecar.
5. Point a `sidecar.yaml` at it with `type: my-agent`.

No changes are needed in the server, dashboard, or protocol — `AgentType` is
an open string and the UI falls back to a generic icon for unknown types.

## Project status

This is the first iteration: Docker Compose only, single-tenant admin auth,
deferred RBAC and OpenTelemetry. See `[AGENTS.md](./AGENTS.md)` for design
notes, gotchas, and known follow-ups.