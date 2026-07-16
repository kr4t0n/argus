<p align="center">
  <img src="assets/argus-icon.png" alt="Argus" width="128" height="128" />
</p>

<h1 align="center">Argus</h1>

A multi-machine **agent management dashboard**. Argus lets you talk to one or
more CLI agents — Claude Code, Codex, Cursor CLI, or your own — running on any
number of machines, and watch their answers stream back into a single
dashboard in real time.

```
            HTTPS+WS                 Redis Streams (commands/results)                  exec
┌─────────┐           ┌────────────┐                                   ┌────────────┐         ┌───────────┐
│   Web   │ ────────▶ │   Server   │ ────────────────────────────────▶ │  Sidecar   │ ──────▶ │ CLI agent │
│ (React) │ ◀──────── │  (NestJS)  │ ◀──────────────────────────────── │    (Go)    │ ◀────── │           │
└─────────┘           └────────────┘  Direct WS (PTY: /sidecar-link)   └────────────┘         └───────────┘
                             │       ════════════════════════════════▶
                             ▼       ◀════════════════════════════════
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

- **Streaming-first UI** — typewriter deltas, tool-call pills, stdout/stderr
blocks, sticky auto-scroll, and replay-on-reconnect.
- **Machine-driven runners** — each host runs one `argus-sidecar` daemon that
self-registers as a *Machine* and starts one runner per installed CLI. Create
**sessions** from the dashboard (hover a project → `+`); each pins to a
`(machine, workingDir)` project and CLI type, and the server routes its turns
to that machine's runner over a per-CLI Redis stream — no YAML to ship to
remote boxes.
- **Sessions = conversations** — long-lived threads tied to the CLI's native
`--resume` ids, so you pick up where you left off.
- **Auto-discovered adapters** — `claude-code`, `codex`, and `cursor-cli` ship
in the box; the sidecar probes `PATH` at boot and the new-session picker only
offers what's installed on that host. New adapters are ~30 lines + an `init()`
call.
- **Per-session model picker** — pick model, thinking effort, 1M context
(Claude Code), and fast tier (Codex) per session; each turn dispatches the
matching CLI flags. Model lists come from the CLIs themselves and are cached
server-side; "Default" passes no flags and a free-text "custom…" id always
works.
- **Token & context badge** — every session header shows cumulative ↑/↓ tokens
and a live context-window donut; hover for the input / cache / USD-cost /
API-time breakdown.
- **Usage ledger** — the `/user` page tallies input / output / cache tokens,
USD cost, and API time across your sessions, with a 7-day / 30-day / all-time
toggle (all three windows returned in one response, so switching is instant).
- **Per-CLI plan-quota panel** — shows how much of each subscription window
you've burned (Claude Code Pro/Max 5-hour + weekly, ChatGPT Codex). Each
sidecar reads the local CLI's OAuth file and refreshes every 5 min on its
heartbeat; failures degrade per-row. (The CLIs' quota endpoints are
undocumented and may change.)
- **Task-completion notifications (opt-in)** — desktop notification + chime
when a session finishes off-screen; click to jump to it. Suppressed for the
session you're already viewing.
- **Soft-archive everywhere** — hide a session or a whole project from the
sidebar without losing history; one-click restore, and archives survive
sidecar restarts.
- **Live workingDir file tree** — a lazy-expanding, gitignore-aware tree kept
in sync by the sidecar's `fsnotify` watcher; the header also shows the current
git branch (or short SHA when detached).
- **File & image attachments** — drag-drop / paste / pick files in the
composer. Images render inline and pass to the agent as vision; other files
land on the sidecar host. Bytes live in any S3-compatible store (bundled
MinIO) that only the *server* needs to reach; files land under
`<workingDir>/.argus/uploads/` and persist for `--resume` turns.
- **Prompt queue** — keep typing while a turn runs; messages queue (editable,
reorderable), dispatch one at a time as the session goes idle, and survive a
reload.
- **Interactive terminal per project (opt-in)** — a real PTY shell (xterm.js +
`creack/pty`) over a direct sidecar↔server WebSocket for sub-10 ms echo, usable
for full-screen TUIs like `vim` and `htop`. Treat it as remote shell access —
enable only where every dashboard user is trusted to that level.
- **Opt-in right-panel extensions** (enable from `/user` → Extensions):
**Notes** (per-project scratchpad synced to your account), **Progress** (live
background-task bars via the `argus-bg` wrapper — surfaces even after `&` /
`nohup`), and **Diff** (files the agent changed in its last turn, `+/-` per
file).
- **Redis Streams bus** — durable, replayable, no extra ops weight on top of
the Redis you already run.

## Repo layout

```
argus/
├── apps/
│   ├── web/                  Vite + React + TS + Tailwind + Zustand
│   ├── server/               NestJS + Prisma + Socket.IO
│   └── ios/                  Native SwiftUI client for iOS/iPadOS (WIP —
│                             ArgusKit foundations; see apps/ios/README.md)
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

## Compatibility & upgrading

Argus ships **server**, **web**, and **sidecar** as one release train — run the
same minor version across all three. The server applies its Prisma migrations
on boot, so a routine upgrade is just "pull the new images, restart, then
update the sidecars" (`argus-sidecar update`, or the dashboard's **Update all
sidecars…**).

### v0.3.0 — the runner refactor (breaking; not compatible with < 0.3.0)

v0.3.0 retires the per-agent model end to end and replaces it with **runners**
(one per machine × CLI). This is a hard break with anything still on a `0.2.x`
or earlier build — **upgrade the server, web, and every sidecar to ≥ 0.3.0
together.** A mixed fleet will not work: a < 0.3.0 sidecar speaks the deleted
per-agent protocol the ≥ 0.3.0 server no longer understands, and vice versa.

What changed:

- **Sidecar protocol** — the legacy pre-runner (per-agent) wire is deleted, so
  older sidecars can't talk to a 0.3.0 server. Run `argus-sidecar update` on
  every host (or trigger it from the dashboard) before/with the server upgrade.
- **Database** — the `Agent` table is dropped (migrations `9_phase5_*` /
  `9_phase6_*`, applied automatically on server boot). Because this drops a
  table, **downgrading the server below 0.3.0 after upgrading is not
  supported** — snapshot your database first if you need a rollback path.
- **REST API** — the `/agents` endpoints are gone. Address work through
  `/sessions`, `/projects`, and `/machines` instead; `agentId` is removed from
  every DTO and event, and `Machine.agentCount` / `AgentDTO` no longer exist.
  Any integration or API key that called `/agents` must move to those routes.
- **Clients** — the web and native iOS clients dropped all agent identity, so
  an older client pointed at a 0.3.0 server (or a 0.3.0 client pointed at an
  older server) will not function.

Nothing you created is lost: existing **sessions, commands, results, and
projects** carry over untouched — only the redundant per-agent bookkeeping is
removed. Sessions now route by `projectId → machine + CLI type → runner
stream`.

## Quick start

> Just want to deploy Argus, not develop on it? See
> [**INSTALLATION.md**](INSTALLATION.md) for the production install
> guide — it covers managed Postgres / Redis options, putting the
> dashboard behind a reverse proxy, and installing sidecars on remote
> agent machines with launchd / systemd recipes. Running on
> Kubernetes? `helm repo add argus https://kr4t0n.github.io/argus/helm`
> — full chart docs in [`helm/argus/README.md`](helm/argus/README.md).

### 1. Bring up Postgres, Redis, MinIO, server, and web

```bash
cp .env.example .env
docker compose -f deploy/docker-compose.yml up --build
```

The dashboard is published on **`WEB_PORT`** (default `5173`). If you
customise any value in `.env` (ports, secrets, S3 target), pass it
explicitly — Compose's project directory defaults to `deploy/`, so it
does **not** auto-read a repo-root `.env`:

```bash
# e.g. 5173/5432/9000 already taken on this host:
WEB_PORT=5273 POSTGRES_PORT=55432 S3_PORT=59000 S3_CONSOLE_PORT=59001 \
  docker compose --env-file .env -f deploy/docker-compose.yml up --build
```

The SPA always finds the API at `<hostname>:4000`, independent of
`WEB_PORT`, so only `SERVER_PORT` matters for that wiring.

The bundled **MinIO** (S3-compatible object store) backs file/image
attachments; a one-shot `minio-init` service creates the bucket on first
boot. To use a managed S3 / R2 / external MinIO instead, set the server's
`S3_ENDPOINT` in the compose file (it's pinned to the in-network MinIO so
a host-oriented `.env` value can't leak into the container) and drop the
`minio` services; `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` stay
env-overridable. Only the server needs to reach the bucket.

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

# Or pin to a specific release (0.3.0 is the first runner-native release):
docker pull kr4t0n/argus-server:0.3.0
docker pull kr4t0n/argus-web:0.3.0
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
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | ARGUS_VERSION=0.3.0 sh

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
argus-sidecar status              # running pid, uptime, log + pidfile paths
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
   dashboard's left panel, and starts one runner per installed CLI.
3. Serves sessions on demand: when you create one from the UI, the
   server pins it to a `(machine, workingDir)` project + CLI type and
   routes its turns to the machine's runner over a per-CLI Redis stream.

The machine identity + its project workdir allowlist are cached in
`~/.config/argus/sidecar.json`, so the file jail and watchers come up on
restart without waiting for the server's reconcile broadcast.

To remove a machine from the dashboard, open its panel and use the
**delete** button (works at any status). This is a **soft delete**: the
machine disappears from the dashboard, but nothing is destroyed — every
session, command, and result stays in the database and remains viewable
in your session
history. The removal is sticky: even if that machine's sidecar keeps
running or restarts, the server ignores it and the machine will not
reappear. There is no un-delete from the UI, so the confirmation is
final; the sidecar process itself is left untouched (stop it with
`argus-sidecar stop` on the host if you also want to retire it).

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

`update` also keeps the **`argus-bg`** companion (the tqdm progress
wrapper shipped in the same release that surfaces background-task
progress in the dashboard) in lockstep: unless `argus-bg` already reports
the release `update` resolved to, it fetches and sha256-verifies
`argus-bg` into the same directory. The version check reads `argus-bg`'s
own `version` output, so it also repairs a copy that's present but stale
(or missing, or corrupt — anything it can't confirm is treated as
"refresh"). This is best-effort, so a checksum or permission hiccup on the
companion never fails the sidecar update itself. To force a (re)install of
just the companion without touching the sidecar — handy on installs that
predate `argus-bg`, or to repair a copy — use:

```bash
argus-sidecar download-bg              # install argus-bg next to the sidecar
argus-sidecar download-bg --prerelease # from the latest pre-release
argus-bg version                       # print the baked-in version
```

##### Remote updates from the dashboard

You can also trigger the same self-update remotely from the dashboard so
you don't have to SSH into every host when you cut a new release.

- **Per-machine** — open a machine's focus pane (click its row in the
  bottom-of-sidebar machines list), then use the header kebab menu (⋮)
  and pick **Update sidecar**. A small green badge appears
  next to the title whenever the host is running a sidecar older than
  the latest published release.
- **Whole fleet** — hover the **machines** header in the sidebar and use
  the kebab menu's **Update all sidecars…** action. A modal previews
  which hosts will be updated, which are already current, and which are
  offline (and therefore skipped). Confirm to start; the runner walks
  the fleet sequentially and stops on the first failure so a bad
  release doesn't cascade.

Both paths use the same machinery: the server publishes an
`update-sidecar` command on the host's Redis control stream, the sidecar
reuses its existing `argus-sidecar update` flow to download + verify +
swap the binary (refreshing the `argus-bg` companion in the same step,
best-effort), then chooses how to bring up the new image:

- **`self`** — the daemon was started by `argus-sidecar start` (or any
  other non-supervised invocation). It re-execs the freshly installed
  binary in-place via `syscall.Exec`, preserving the PID and the
  `flock(2)` hold on its pidfile so there's a zero-gap handoff.
- **`supervisor`** — the daemon detected systemd / launchd
  (`INVOCATION_ID`, `XPC_SERVICE_NAME`, …). It exits cleanly with
  status 0 and the supervisor respawns it with the new bytes.
- **`manual`** — the daemon is attached to a TTY (a developer running
  `argus-sidecar` foreground in a terminal). It logs a "restart needed"
  notice and stays on the old version; the dashboard's toast surfaces
  the same message.

Active sessions stay connected across the restart: the dashboard
re-establishes the supervisor link as soon as the new sidecar
re-registers, and pty/terminal sessions reattach without losing
scrollback. The "update available" badge is driven by a 30-minute cache
of the latest GitHub release tag on the server (set `GITHUB_TOKEN` in
the server env to dodge the unauthenticated rate limit).

If you want to gate this action behind admin-only RBAC later it's
straightforward — the endpoints (`POST /machines/:id/sidecar/update`
and `POST /machines/sidecar/update-all`) live in `MachineController`
and inherit the same auth guard as everything else under `/machines`.

#### Creating projects and sessions from the dashboard

Once a machine has registered it shows up in the bottom-of-sidebar
**machines** list. Hover its row and click the `+` to create a **project** —
the `(machine, workingDir)` anchor your sessions live under:

- **working dir** — the directory the CLI is launched in; every file edit and
  shell command resolves relative to it. It can't change later, because the
  CLIs key their `--resume` state on the cwd.
- **name** — what you'll see in the sidebar.
- **attach interactive terminal** — opt-in PTY (see the security note below).

The project appears in the sidebar immediately. Hover it and click its `+` to
create a **session**: pick the adapter (pre-filtered to what's installed on
that host) and a name, then start a streaming chat. A session pins to its
project + CLI type for life.

To hide a project or session from the sidebar without losing data, use its
**archive** action — the row stays in Postgres and restores with one click.

#### Optional: interactive terminal opt-in

The PTY is per-project, enabled at project-create time via the "attach
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
| Print the sidecar's baked-in version| `argus-sidecar version`                               |
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
| `S3_ENDPOINT`          | S3-compatible endpoint for attachment storage (bundled MinIO by default) |
| `S3_BUCKET`            | Bucket attachments are stored in (`argus-attachments`)  |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Object-store credentials                     |
| `S3_REGION`            | Region sent to the S3 client (`us-east-1`; ignored by MinIO) |
| `ATTACHMENT_MAX_FILE_BYTES` | Per-file upload cap in bytes (default 25 MiB)      |
| `ATTACHMENT_MAX_FILES` | Max attachments per turn (default 10)                   |
| `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_KEY_BASE64` | APNs auth key for the native iOS client's push notifications; unset = push disabled (see `.env.example`) |
| `APNS_TOPIC` / `APNS_ENV` | iOS bundle id (`app.argus.ios`) and APNs environment (`sandbox`/`production`) |


## API keys

The REST API is normally reached with a JWT from `POST /auth/login`. For
machine-to-machine callers (dashboards, integrations) you can instead mint a
**revocable API key**. Unlike a JWT it can be revoked without rotating
`JWT_SECRET` (which would log out every user), and it can be restricted to
read-only.

Manage keys from the dashboard — the user panel's **API keys** section lets you
create a key (with a read-only toggle), copy and test the one-time secret, and
revoke keys. Or use the REST API directly.

Mint one with a logged-in admin token (`$API` is your server URL, e.g.
`http://localhost:4000`):

```bash
TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@argus.local","password":"…"}' | jq -r .token)

# readonly defaults to true; pass "readonly": false for a read/write key
curl -s -X POST "$API/auth/api-keys" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"dashboard"}'
# → {"id":"…","name":"dashboard","prefix":"argus_AbCd12","readonly":true,"key":"argus_…"}
```

The `key` is shown **once** — store it, it cannot be retrieved again. Then call
the API with it in the `X-API-Key` header:

```bash
curl -s "$API/sessions" -H "X-API-Key: argus_…"           # 200 — reads work
curl -s -X POST "$API/sessions" -H "X-API-Key: argus_…"   # 403 — read-only key
```

A read-only key is confined to `GET`/`HEAD`/`OPTIONS`; every mutation is
rejected with 403. List keys with `GET /auth/api-keys` and revoke one with
`DELETE /auth/api-keys/:id` (both JWT-only — an API key can't manage keys). A
key acts as the user who created it, so per-user data (e.g. sessions) stays
scoped to that account — create a dedicated `viewer` user for an integration
if you don't want it tied to your admin login.

## Adding a custom CLI agent

1. Create `packages/sidecar/internal/adapter/myagent.go`.
2. Implement the `Adapter` interface (usually 20–40 lines — reuse `clistream.Start`).
3. Call `adapter.Register("my-agent", &adapter.Plugin{Factory: newMyAgent, DefaultBinary: "my-cli"})` from `init()`.
4. Rebuild the sidecar with `make` (or just `go build` for a host-only binary).
5. The next time the daemon boots it will discover `my-cli` on `PATH` and
   make it selectable in the dashboard's new-session popover.

No changes are needed in the server, dashboard, or protocol — `AgentType` is
an open string and the UI falls back to a generic icon for unknown types.

## Project status

Actively developed. Deploy via Docker Compose or the Helm chart (`helm repo add
argus https://kr4t0n.github.io/argus/helm`); a native SwiftUI iOS/iPadOS client
is in progress (see [`apps/ios/README.md`](apps/ios/README.md)). Single-tenant
admin auth today, with RBAC and OpenTelemetry still deferred. See
[`AGENTS.md`](./AGENTS.md) for design notes, gotchas, and known follow-ups.