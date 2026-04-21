# Argus

A multi-machine **agent management dashboard**. Argus lets you talk to one or
more CLI agents — Claude Code, Codex, Cursor CLI, or your own — running on any
number of machines, and watch their answers stream back into a single
dashboard in real time.

```
┌────────┐  HTTPS+WS   ┌─────────────┐  Redis Streams (commands/results)  ┌──────────────┐  exec  ┌────────────┐
│  Web   │ ─────────▶ │   Server    │ ─────────────────────────────────▶ │   Sidecar    │ ─────▶ │  CLI agent │
│ (React)│ ◀───────── │ (NestJS)    │ ◀───────────────────────────────── │   (Go)       │ ◀───── │            │
└────────┘            └─────────────┘   Direct WS (PTY: /sidecar-link)    └──────────────┘        └────────────┘
                            │           ═══════════════════════════════▶
                            ▼           ◀═══════════════════════════════
                       Postgres
```

The control plane never speaks to a CLI directly: every CLI is wrapped by a
small Go *sidecar* that translates the CLI's native streaming output into a
common `ResultChunk` format. Control-plane traffic (commands, lifecycle,
streamed results) flows over **Redis Streams** for durability and replay;
interactive **terminal (PTY) traffic** flows over a **direct sidecar↔server
WebSocket** so keystroke echo stays sub-10 ms even on regional Redis. The
server relays everything to the browser over Socket.IO so you get true
token-level streaming with reconnect-safe replay.

## Features

- **Streaming-first UI**: typewriter deltas, tool-call pills, stdout/stderr
blocks, auto-scroll-with-stickiness, replay-on-reconnect.
- **Machine-driven agents**: each host runs one `argus-sidecar` daemon
that self-registers as a *Machine*. Agents are created from the
dashboard ("hover a machine, click +") and the server pushes them
down to the sidecar over a per-machine Redis control stream — no
YAML files to ship to remote boxes.
- **Sessions = conversations**: long-lived chat threads tied to the CLI's
native `--resume` ids so you can pick up where you left off.
- **Pluggable adapters with auto-discovery**: `claude-code`, `codex`,
`cursor-cli` ship in the box; the sidecar probes `PATH` at boot and
the dashboard's "create agent" dropdown is filtered to whatever's
actually installed on that machine. New adapters are ~30 lines + an
`init()` register call.
- **Soft-archive everywhere**: hide a session or an entire agent from the
sidebar without losing history. The data stays in Postgres and can be
restored with one click; archived agents stay archived even if the
sidecar restarts.
- **Interactive terminal per agent (opt-in)**: tick the "attach
interactive terminal" box when creating an agent and the dashboard's
right panel grows a real PTY shell on that machine — full ANSI
colors, resize, ctrl-C, the works. xterm.js on the front,
`creack/pty` in the sidecar. Traffic rides a direct sidecar↔server
WebSocket (not Redis) for sub-10 ms keystroke echo, usable for
full-screen TUIs like `vim` and `htop`. Treat the opt-in as remote
shell access: only enable on hosts where every dashboard user is
trusted to that level.
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
└── deploy/                   docker-compose + Dockerfiles
```

## Prerequisites

- **Node.js** ≥ 20 and **pnpm** ≥ 10
- **Go** ≥ 1.23 (only needed if you build the sidecar locally)
- **Docker** + Docker Compose (only needed for the bundled local stack)
- **Postgres** 16+ and **Redis** 7+ if not using Compose
- A CLI agent on PATH for any sidecar you run locally
(`claude`, `codex`, or `cursor-agent`)

## Quick start

> Just want to deploy Argus, not develop on it? See
> [**INSTALLATION.md**](INSTALLATION.md) for the production install
> guide — it covers managed Postgres / Redis options, putting the
> dashboard behind a reverse proxy, and installing sidecars on remote
> agent machines with launchd / systemd recipes. Running on
> Kubernetes? `helm repo add argus https://kr4t0n.github.io/argus/helm`
> — full chart docs in [`helm/argus/README.md`](helm/argus/README.md).

### 1. Bring up Postgres, Redis, server, and web

```bash
cp .env.example .env
docker compose -f deploy/docker-compose.yml up --build
```

The dashboard is at [http://localhost:5173](http://localhost:5173). Sign in with the seeded admin
credentials (`admin@argus.local` / `changeme` by default — change them in
`.env`).

#### Pulling pre-built images instead of building locally

Tagged commits and pushes to `main` publish multi-arch (linux/amd64 +
linux/arm64) images to Docker Hub via `.github/workflows/docker-publish.yml`:

- [`kr4t0n/argus-server`](https://hub.docker.com/r/kr4t0n/argus-server)
- [`kr4t0n/argus-web`](https://hub.docker.com/r/kr4t0n/argus-web)

```bash
docker pull kr4t0n/argus-server:latest    # tracks main
docker pull kr4t0n/argus-web:latest

# Or pin to a specific release:
docker pull kr4t0n/argus-server:0.1.0
docker pull kr4t0n/argus-web:0.1.0
```

Tag schedule per image: `:latest` (main), `:<branch>`, `:<X.Y.Z>` and
`:<X.Y>` (semver from `v*` tags), and `:sha-<short>` for every build.

Override the `image:` field in `deploy/docker-compose.yml` (or use a
`docker-compose.override.yml`) to skip the local `build:` and pull
those instead. The server image runs `prisma migrate deploy` on every
boot, so first-time and rolling deployments need no manual migration
step. The web image is generic — `host.ts` derives the API base URL
from the browser's hostname at runtime, so the same image works behind
any reverse proxy.

### 2. Install and run a sidecar

The sidecar is **not** part of compose on purpose: you run it on whatever
machine actually has the CLI you want to expose. There are three ways
to get the binary onto that machine — pick whichever fits.

#### Option A — one-line installer (recommended)

```bash
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | sh
```

That detects your OS/arch (`darwin`/`linux`, `amd64`/`arm64`),
resolves the latest `argus-sidecar-v*` release, downloads the matching
binary, **verifies its SHA-256 against the release's `SHASUMS256.txt`**,
and drops it in `/usr/local/bin` (or `$HOME/.local/bin` if that isn't
writable). Knobs:

```bash
# Pin a specific version
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | ARGUS_VERSION=0.1.0 sh

# Install somewhere else
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | ARGUS_INSTALL_DIR=$HOME/bin sh

# Private repo? Use a token (gh auth token works on dev machines)
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | GITHUB_TOKEN=ghp_xxx sh
```

#### Option B — download a published binary

Grab the right asset from the [latest sidecar release](https://github.com/kr4t0n/argus/releases?q=argus-sidecar)
(`argus-sidecar-{darwin,linux}-{amd64,arm64}`), `chmod +x` it, and
move it onto your `$PATH`. Verify the checksum against the release's
`SHASUMS256.txt`.

#### Option C — build from source

```bash
cd packages/sidecar && make              # → bin/argus-sidecar

# Or cross-compile a static binary for a remote Linux box
make linux-amd64                         # → bin/argus-sidecar-linux-amd64
make linux-arm64                         # → bin/argus-sidecar-linux-arm64
make cross                               # builds all supported GOOS/GOARCH
```

The cross-compiled binaries are fully static (no cgo, no glibc
dependency) — scp them straight onto the target machine and run.

#### Initialize and run

The sidecar has no YAML config — there's a one-time interactive `init`
that asks for the bus URL, the server URL, and an optional friendly
machine name (defaults to the hostname), then writes the answers to
`~/.config/argus/sidecar.json`. Subsequent runs just read that file:

```bash
argus-sidecar init                # interactive
argus-sidecar                     # daemon — starts in the foreground

# Or fully scripted:
argus-sidecar init \
  --bus  redis://default:PASS@your-redis-host:6379 \
  --server http://argus.your.tld:4000 \
  --token "$SIDECAR_LINK_TOKEN"   # only needed if you set the server-side token
```

##### Daemon control

For interactive use, the sidecar ships its own background-mode wrapper —
no `systemd`/`launchd` unit required to keep it alive after you close the
terminal:

```bash
argus-sidecar start               # detach + log to ~/.local/state/argus/sidecar.log
argus-sidecar status              # running pid, uptime, configured agents, log path
argus-sidecar restart             # graceful stop + start
argus-sidecar stop                # SIGTERM, then SIGKILL after --timeout (default 10s)
argus-sidecar stop --force        # SIGKILL immediately
```

State files (`sidecar.pid`, `sidecar.log`) live under
`$XDG_STATE_HOME/argus/` (default: `~/.local/state/argus/`); both paths are
overridable via `--pid-file` / `--log-file`. The bare `argus-sidecar`
invocation (and the explicit `argus-sidecar run` alias) is unchanged and
remains the right `ExecStart=` for `systemd`/`launchd` units. Both modes
take the same advisory `flock(2)` on the pidfile, so you can't accidentally
run two daemons against one cache (which would share a `machineId` and
confuse the server).

The log file is append-only — wire it into `newsyslog` (macOS) or
`logrotate` (Linux) if you want rotation. Example `logrotate`:

```
~/.local/state/argus/sidecar.log {
    weekly
    rotate 4
    missingok
    notifempty
    copytruncate
}
```

On boot the daemon:

1. Probes `PATH` for every adapter it knows about (`claude`, `codex`,
   `cursor-agent`, …) and reports what it finds back to the server.
2. Self-registers as a `Machine` row visible at the bottom of the
   dashboard's left panel.
3. Sits idle until you create an agent on it from the UI — at which
   point the server pushes a `create-agent` command down the
   per-machine Redis stream and the daemon spawns a supervisor for
   that adapter.

Created agents are cached in `~/.config/argus/sidecar.json`, so a
sidecar restart immediately re-spawns every supervisor without waiting
for the server's reconcile broadcast.

To upgrade an installed sidecar in place to the latest published release
for its OS/arch, run:

```bash
argus-sidecar update                # downloads, sha256-verifies, swaps
argus-sidecar update --prerelease   # also consider pre-release tags
argus-sidecar update --force        # reinstall even if already current
argus-sidecar version               # print the baked-in version
```

The update is atomic (`os.Rename` over the running executable). Restart
your launchd/systemd unit afterwards to pick up the new binary. If the
GitHub repo is private, set `GITHUB_TOKEN` in the environment so the
update can read the release asset list.

#### Creating agents from the dashboard

Once a machine has registered, hover over its row in the bottom-of-the-
sidebar **machines** list and click the `+`. A small popover lets you
pick:

- **adapter** — pre-filtered to what was discovered on that host.
- **name** — what you'll see in the sidebar.
- **working dir** — the directory the wrapped CLI is launched in
  (optional; defaults to the daemon's cwd). Every file edit and shell
  command the agent runs resolves relative to this.
- **attach interactive terminal** — opt-in PTY (see the security note
  below).

Click **create**. The agent appears in the sidebar within a fraction
of a second; click it and `+ new session` to start a streaming chat.

To remove an agent permanently, open the machine's focus view (click
the machine name) and use the trash icon next to the agent. That
hard-deletes the agent and its history. To just hide an agent from
the sidebar without losing data, use the **archive** button on its
sidebar row instead.

#### Optional: interactive terminal opt-in

The PTY is per-agent, enabled at create time via the "attach
interactive terminal" checkbox. Server-side, set
`SIDECAR_LINK_TOKEN` in `.env` to a long random string in production
and pass the same value as `--token` to `argus-sidecar init`. An
empty server-side token is accepted for local dev (the server logs a
loud warning on boot).

> **Security**: enabling the terminal grants every dashboard user
> shell-as-sidecar-user on this host. Only enable on machines where
> that's an acceptable trust model. The sidecar enforces a default
> shell allowlist (`$SHELL`, `/bin/bash`, `/bin/zsh`, `/bin/sh`) and
> a session cap; the server scopes terminals to the opening user;
> every open/close is recorded in the `Terminal` table for audit.
> Transcripts are **not** persisted by design.

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

# Sidecar (one-time init, then run)
cd packages/sidecar
go run ./cmd/sidecar init --bus redis://localhost:6379 --server http://localhost:4000
go run ./cmd/sidecar
```

## Common tasks


| What you want                       | Command                                               |
| ----------------------------------- | ----------------------------------------------------- |
| Typecheck everything                | `pnpm typecheck`                                      |
| Build everything                    | `pnpm build`                                          |
| Apply a Prisma migration            | `pnpm --filter @argus/server exec prisma migrate dev` |
| Re-seed the admin user              | `pnpm --filter @argus/server seed`                    |
| List adapters compiled into sidecar | `./packages/sidecar/bin/argus-sidecar --list-adapters`|
| Re-init sidecar config              | `argus-sidecar init --force`                          |
| Show sidecar's cached config path   | `argus-sidecar version`                               |
| Open Prisma Studio                  | `pnpm --filter @argus/server exec prisma studio`      |


## Environment variables

See `[.env.example](./.env.example)` for the full list. Highlights:


| Variable               | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `DATABASE_URL`         | Postgres connection string used by Prisma               |
| `REDIS_URL`            | Redis connection string used by server **and** sidecars |
| `JWT_SECRET`           | HMAC secret for auth tokens                             |
| `ADMIN_EMAIL/PASSWORD` | Bootstrapped admin credentials                          |
| `ARGUS_API_URL`        | Runtime URL the web app uses for REST calls (rendered into `/config.js` at container start; empty = derive from the page hostname) |
| `ARGUS_WS_URL`         | Runtime URL the web app uses for Socket.IO; defaults to `ARGUS_API_URL` |
| `VITE_API_URL`         | Build-time fallback baked into the web bundle (only used if you build your own image) |
| `VITE_WS_URL`          | Build-time fallback for Socket.IO (only used if you build your own image) |


## Adding a custom CLI agent

1. Create `packages/sidecar/internal/adapter/myagent.go`.
2. Implement the `Adapter` interface (usually 20–40 lines — reuse `clistream.Start`).
3. Call `adapter.Register("my-agent", &adapter.Plugin{Factory: newMyAgent, DefaultBinary: "my-cli"})` from `init()`.
4. Rebuild the sidecar with `make` (or just `go build` for a host-only binary).
5. The next time the daemon boots it will discover `my-cli` on `PATH` and
   make it selectable in the dashboard's "create agent" popover.

No changes are needed in the server, dashboard, or protocol — `AgentType` is
an open string and the UI falls back to a generic icon for unknown types.

## Project status

This is the first iteration: Docker Compose only, single-tenant admin auth,
deferred RBAC and OpenTelemetry. See `[AGENTS.md](./AGENTS.md)` for design
notes, gotchas, and known follow-ups.