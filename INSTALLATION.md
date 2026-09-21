# Argus — Installation Guide

This guide walks through a fresh, production-style install of Argus from
zero to a working dashboard with one or more remote machines reporting in.

The install splits into two halves:

1. **Control plane** (one place) — Postgres + Redis + the `argus-server`
  API + the `argus-web` UI. Deploy these together on a single host or
   spread them across managed services.
2. **Sidecars** (one per agent machine) — the small Go binary that wraps
  a local CLI (`claude`, `codex`, `cursor-agent`, …) and reports back to
   the control plane.

```
                       ┌────────────────── control plane ──────────────────┐
┌────────┐  HTTPS+WS   │ ┌─────────────┐    ┌────────────┐                  │
│  You   │ ─────────▶  │ │ argus-web   │ ─▶ │ argus-     │  ◀── Redis ───  │  ◀── any number of
│ (Web)  │             │ │ (nginx SPA) │    │ server     │  ◀── Postgres   │      sidecars on any
└────────┘             │ └─────────────┘    │ (NestJS)   │                  │      number of hosts
                       │                    └────────────┘                  │
                       └───────────────────────────────────────────────────┘
                                              ▲
                                              │ Redis (commands/results)
                                              │ direct WS  (PTY traffic)
                                              ▼
                              ┌───────────────────────────┐
                              │  argus-sidecar (Go)       │      ← installed once per
                              │  + claude / codex /       │        machine that hosts a CLI
                              │    cursor-agent           │
                              └───────────────────────────┘
```

You can run all of this on one machine (everything on `localhost`) or
mix and match — managed Postgres, hosted Redis, dashboard on a small
VPS, sidecars on whatever boxes have the CLIs installed.

---

## Prerequisites

For the control-plane host:

- Docker 24+ and Docker Compose v2 (`docker compose ...`)
- Outbound access to Docker Hub (for `kr4t0n/argus-server` and `kr4t0n/argus-web`)
- Connectivity to your chosen Postgres + Redis (whether local containers or remote)

For each sidecar host (separate from the control plane in production):

- Linux (amd64/arm64) or macOS (amd64/arm64)
- The CLI you want to expose, on `$PATH` (`claude`, `codex`, or `cursor-agent`)
- Outbound access to your Redis URL, and to the server's HTTP(S) port
if you'll enable the interactive terminal feature

---

## Part 1 — Control plane

### Step 1: Provision Postgres

Argus stores users, machines, projects, sessions, and command history in
Postgres.
You can either run a Postgres container on the same host as the server
or point at a managed service. Pick one.

#### Option A — Self-hosted in Docker Compose (simplest)

You don't need to do anything extra here — the Compose file in
`[deploy/docker-compose.yml](deploy/docker-compose.yml)` already starts
a Postgres 16 container with a volume. Skip ahead to Step 3 and use the
defaults.

#### Option B — Self-hosted on a separate VM

Stand up Postgres 16 with a normal package install, create a database
and a role with full DDL privileges (Argus's first boot creates tables
via `prisma migrate deploy`):

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE argus WITH LOGIN PASSWORD 'replace-me';
CREATE DATABASE argus OWNER argus;
GRANT ALL PRIVILEGES ON DATABASE argus TO argus;
SQL
```

Resulting connection string:

```
DATABASE_URL=postgresql://argus:replace-me@db.internal:5432/argus?schema=public
```

For TLS-required hosts append `&sslmode=require`.

#### Option C — Managed Postgres (recommended for production)

Any standard Postgres-compatible service works. The connection string
they hand you slots into `DATABASE_URL` directly.


| Provider     | What to provision                             | Notes                                                                                                           |
| ------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Neon**     | A project with a single database              | Use the *pooled* connection string only if you append `?pgbouncer=true&connection_limit=1`                      |
| **Supabase** | A project; grab the "Connection string" → URI | Use the **direct** connection (port 5432), not the PgBouncer pool, so Prisma migrations can take advisory locks |
| **Railway**  | A Postgres plugin                             | Internal URL works once the server runs in the same project                                                     |
| **AWS RDS**  | A `db.t4g.micro` is plenty for solo use       | Make sure the VPC security group allows the server host                                                         |
| **Render**   | A Postgres database                           | Use the *External Database URL*; append `?sslmode=require`                                                      |
| **Fly.io**   | `flyctl postgres create`                      | Hand the attached connection string straight to the server                                                      |


Whichever you pick, the database itself must already exist —
`prisma migrate deploy` creates *tables*, it does not run
`CREATE DATABASE`. Managed services do this automatically when you
provision; on self-hosted Postgres see Option B above.

---

### Step 2: Provision Redis

Argus uses Redis Streams for control-plane traffic (commands, lifecycle
events, streamed results). Same pattern: container alongside, separate
self-hosted, or a managed service.

#### Option A — Self-hosted in Docker Compose (simplest)

The bundled Compose file already includes a Redis 7 container. Nothing
to do. Skip to Step 3.

#### Option B — Self-hosted on a separate VM

```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
```

Connection string: `REDIS_URL=redis://redis.internal:6379`

For passworded Redis: `redis://default:<password>@host:6379`.
For TLS: use the `rediss://` scheme.

#### Option C — Managed Redis (recommended for production)


| Provider             | Notes                                                               |
| -------------------- | ------------------------------------------------------------------- |
| **Upstash Redis**    | Free tier handles solo use comfortably. Enable TLS → `rediss://...` |
| **AWS ElastiCache**  | Single-node Redis 7 cluster; place in same VPC as the server        |
| **Redis Cloud**      | "Fixed" free 30 MB tier is enough for getting started               |
| **Railway / Render** | One-click Redis plugins; copy the URL straight in                   |


Argus does **not** need Redis persistence. RDB or AOF is fine but not
required — the bus is a transport, not a source of truth. Anything you
care about lives in Postgres.

---

### Step 3: Deploy `argus-server` + `argus-web`

Pre-built multi-arch images live on Docker Hub:

- `[kr4t0n/argus-server](https://hub.docker.com/r/kr4t0n/argus-server)`
- `[kr4t0n/argus-web](https://hub.docker.com/r/kr4t0n/argus-web)`

Both are tagged `:latest` (tracks `main`), `:0.1.0` / `:0.1` (semver),
and `:sha-<short>` for traceability. Pin to a `:X.Y.Z` tag in production.

Create a directory on the control-plane host:

```bash
mkdir -p ~/argus && cd ~/argus
```

Drop in this `docker-compose.yml`:

```yaml
services:
  server:
    image: kr4t0n/argus-server:0.1.0
    restart: unless-stopped
    env_file: .env
    ports:
      - '4000:4000'

  web:
    image: kr4t0n/argus-web:0.1.0
    restart: unless-stopped
    depends_on: [server]
    environment:
      # Optional — leave blank to let the SPA derive the API URL from
      # the browser's own hostname at port 4000 (works for localhost
      # and LAN dev). Set to e.g. https://argus-api.example.com if you
      # split the API onto a separate hostname behind a reverse proxy.
      ARGUS_API_URL: ""
      ARGUS_WS_URL: ""
    ports:
      - '5173:80'
```

And a sibling `.env` file. **Generate fresh secrets** —
`openssl rand -hex 32` is your friend:

```bash
# ─── Postgres (use whichever URL you provisioned in Step 1) ───
DATABASE_URL=postgresql://argus:STRONG_PW@db.example.com:5432/argus?schema=public&sslmode=require

# ─── Redis (from Step 2) ───
REDIS_URL=rediss://default:STRONG_PW@redis.example.com:6379

# ─── Server ───
SERVER_PORT=4000
JWT_SECRET=<paste output of: openssl rand -hex 32>
# `never` mints non-expiring tokens — recommended so long-lived terminal
# sessions don't get torn down by a mid-session token refresh. Override
# with e.g. `7d` for stricter shops.
JWT_EXPIRES_IN=never

# Shared secret for the direct sidecar↔server WebSocket used by the
# interactive terminal. Required if any sidecar enables `terminal.enabled`.
# Leave blank to disable terminal auth (dev only — the server logs a warning).
SIDECAR_LINK_TOKEN=<paste another: openssl rand -hex 32>

# ─── Seed admin (created on first boot if absent) ───
ADMIN_EMAIL=you@your-domain.com
ADMIN_PASSWORD=<a-strong-password>
```

Bring it up:

```bash
docker compose up -d
docker compose logs -f server
```

You should see the migration log followed by:

```
Bootstrapped admin you@your-domain.com
Argus control plane listening on :4000
```

The web image is **runtime-configurable**: it renders `/config.js` from
the `ARGUS_API_URL` / `ARGUS_WS_URL` env vars at container start, and
`host.ts` reads `window.__ARGUS_CONFIG__` first. If those are blank,
the SPA falls back to deriving `<browser-hostname>:4000`, so the same
image works whether you reach the dashboard at `http://localhost:5173`,
the host's LAN IP, or a public domain behind a reverse proxy. No
rebuild needed in any of these cases.

#### Putting it behind a reverse proxy

For production, terminate TLS at a reverse proxy and proxy both `:4000`
(API + WebSockets) and `:5173` (web). Caddy example:

```caddyfile
argus.example.com {
    reverse_proxy /api/* localhost:4000
    reverse_proxy /socket.io/* localhost:4000
    reverse_proxy /sidecar-link localhost:4000
    reverse_proxy /terminal/* localhost:4000
    reverse_proxy localhost:5173
}
```

WebSocket upgrade is automatic in Caddy. For nginx remember
`proxy_set_header Upgrade $http_upgrade;` + `Connection "upgrade"` on
the API location.

#### Deploying on Kubernetes (Helm)

If you'd rather run the control plane on a cluster, the same images
ship as a Helm chart published to a GitHub Pages-served repo:

```bash
helm repo add argus https://kr4t0n.github.io/argus/helm
helm repo update

helm install argus argus/argus \
  --namespace argus --create-namespace \
  --set externalDatabase.url='postgresql://argus:STRONG_PW@db.example.com:5432/argus?schema=public&sslmode=require' \
  --set externalRedis.url='rediss://default:STRONG_PW@redis.example.com:6379' \
  --set auth.jwtSecret="$(openssl rand -hex 32)" \
  --set auth.adminPassword='<a-strong-password>' \
  --set auth.sidecarLinkToken="$(openssl rand -hex 32)"
```

Postgres and Redis stay external (managed services or in-cluster
sub-charts) — the chart deploys only `argus-server` + `argus-web` plus
optional `Ingress`. See [`helm/argus/README.md`](./helm/argus/README.md)
for the full values reference and ingress recipes.

### Step 4: Sign in

Open `http://<host>:5173` (or your proxied domain). Sign in with the
`ADMIN_EMAIL` / `ADMIN_PASSWORD` you set. The sidebar will be empty —
that's expected; machines only show up after at least one sidecar has
registered. On to Part 2.

---

## Part 2 — Sidecars

A sidecar is one Go binary you run on each machine that may host one
or more CLI agents. It does four things:

1. Registers itself as a *Machine* with the server on boot and reports
  which CLI adapters it found on `PATH` (so the dashboard's new-session
   picker shows only what's actually installed).
2. Starts one **runner** per installed CLI type and keeps it subscribed
  to that runner's Redis command stream.
3. Executes each turn via the local CLI in the session's pinned working
  directory, and streams results back.
4. Optionally hosts a PTY per project for the interactive terminal in
  the dashboard.

You install **one sidecar per machine**, regardless of how many CLIs or
projects you plan to run on it. A single Mac with both `claude` and
`codex` installed runs one daemon and starts two runners. A fleet of
five build boxes runs five daemons (one each), and you create projects
and sessions on whichever fleet member you want.

### Step 5: Install the binary

Three ways to get the binary onto the agent machine — pick whichever
fits — plus how it upgrades itself once it's there (Option D).

#### Option A — One-line installer (recommended)

```bash
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | sh
```

This script:

1. Detects your OS (`darwin`/`linux`) and arch (`amd64`/`arm64`).
2. Resolves the newest **stable** `argus-sidecar-v*` release.
3. Downloads the matching binary **and** the release's
  `SHASUMS256.txt`, verifies the SHA-256 before installing.
4. Drops the binary in `/usr/local/bin` (or `$HOME/.local/bin` if that
  isn't writable, with a `PATH` reminder printed at the end).
5. Performs an atomic `mv` over any existing copy, so re-running the
  installer is a safe upgrade path.

Common overrides:

```bash
# Pin a specific release
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh \
  | ARGUS_VERSION=0.1.0 sh

# Install somewhere bespoke
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh \
  | ARGUS_INSTALL_DIR=/opt/argus/bin sh

# Take the newest -rc/-alpha/-beta instead of the newest stable
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh \
  | ARGUS_PRERELEASE=1 sh

# Private repo — pass a GitHub token (PAT or `gh auth token`)
curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh \
  | GITHUB_TOKEN=ghp_xxx sh
```

**Fleet installs and rate limits.** By default the installer makes no
`api.github.com` requests at all: it resolves the release from the
repo's Atom feed and pulls assets from the `/releases/download/`
redirect, neither of which counts against the REST API's 60
requests-per-hour-per-IP budget. That budget is shared by every machine
behind one NAT egress, so rolling out across a fleet used to fail
partway through with a `403` that reads like an auth error. Setting
`GITHUB_TOKEN` switches resolution back to the API, which is what a
private repo needs and where 5000 req/h makes the quota moot.

The installer is POSIX `sh` (no bashisms) and works on Alpine, Debian,
RHEL, macOS — anywhere `curl` (or `wget`) and `sha256sum` (or
`shasum`) exist. Inspect the script before piping to a shell if your
threat model requires it: it lives at
`[scripts/install.sh](scripts/install.sh)` in the repo, and the
release workflow attaches a copy to every release for tagged-version
auditability.

#### Option B — Manual download

Same artifacts, no script. Useful when curl-pipe-sh is disallowed by
policy or the host is air-gapped.

```bash
# On the agent machine:
OS=$(uname -s | tr '[:upper:]' '[:lower:]')        # darwin | linux
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
VERSION=v0.1.0

curl -L -o /usr/local/bin/argus-sidecar \
    "https://github.com/kr4t0n/argus/releases/download/argus-sidecar-${VERSION}/argus-sidecar-${OS}-${ARCH}"
chmod +x /usr/local/bin/argus-sidecar
argus-sidecar version
```

> If the repo is private, the unauthenticated download will 404. Either
> make releases public, or `export GH_TOKEN=...` and use
> `gh release download argus-sidecar-${VERSION} -p "argus-sidecar-${OS}-${ARCH}"`.
> The Option A installer handles private repos transparently as long as
> `GITHUB_TOKEN` is set.

#### Option C — Build from source

Useful if you want to bake in custom adapters. Requires Go 1.25+ (see
`packages/sidecar/go.mod`; CI builds on 1.25).

```bash
git clone https://github.com/kr4t0n/argus.git
cd argus/packages/sidecar
make                                  # → bin/argus-sidecar (host)
sudo install -m 0755 bin/argus-sidecar /usr/local/bin/
```

Cross-compile from a single dev machine for remote installs:

```bash
make linux-amd64 linux-arm64 darwin-amd64 darwin-arm64
ls bin/
# argus-sidecar-linux-amd64  argus-sidecar-darwin-arm64  ...
scp bin/argus-sidecar-linux-amd64 user@build-box:/usr/local/bin/argus-sidecar
```

These binaries are fully static (`CGO_ENABLED=0`), so they run on any
glibc/musl Linux without dependencies.

#### Option D — In-place upgrades

Once installed, the sidecar updates itself:

```bash
argus-sidecar update              # downloads, sha256-verifies, atomic swap
argus-sidecar update --prerelease # also consider pre-release tags
argus-sidecar update --force      # reinstall even if already current
argus-sidecar update --restart    # restart the running sidecar without asking
argus-sidecar update --no-restart # never restart; just print the command
argus-sidecar version             # print the baked-in tag
```

The swap is atomic (`os.Rename` over the running executable), which
means anything already running keeps the old inode — and the old code —
until it is replaced. So once the swap lands, `update` offers to restart
whatever is running it: the service installed in Step 7 if there is one,
otherwise a daemon backgrounded by `argus-sidecar start`. At a TTY it
asks (default yes, warning that in-flight agent turns will be
interrupted); with no TTY — cron, CI, a config-management run — it never
blocks and prints the command instead. `--restart` / `--no-restart`
decide up front. Nothing running means nothing to do.

Like the installer, `update` resolves releases without touching
`api.github.com` unless `GITHUB_TOKEN` is set.

Sidecars up to 0.3.x also shipped an `argus-bg` companion binary next
to the sidecar. It is retired: `update` (and the installer) remove any
leftover copy, and nothing else needs to change on the host.

### Step 6: Initialize the sidecar

The sidecar has no YAML config file. There's a one-time `init`
subcommand that records the bus URL, the server URL, and a friendly
machine name in `~/.config/argus/sidecar.json` (override the path
with `-cache /etc/argus/sidecar.json` for a system-wide install).
After that, the daemon just reads that file on every start.

#### Interactive

```bash
argus-sidecar init
```

You'll be asked for:

- **Bus URL** — the Redis URL the control plane uses (same value as
the server's `REDIS_URL` from Step 2).
- **Server URL** — `http(s)://argus.your.tld:4000`. Required if you
plan to use the interactive terminal feature; harmless to set even
if you don't.
- **Machine name** — defaults to `os.Hostname()` with the macOS
`.local` suffix stripped. Override if you have two boxes with the
same hostname or want a friendlier label.
- **Sidecar link token** — only needed if the server has
`SIDECAR_LINK_TOKEN` set in its `.env`. Same value on both sides.

#### Scripted (recommended for automation)

Every prompt has a corresponding flag, so the same setup runs cleanly
under Ansible / Terraform / a setup script:

```bash
sudo argus-sidecar init \
  --bus     "rediss://default:STRONG_PW@redis.example.com:6379" \
  --server  "https://argus.example.com" \
  --token   "$SIDECAR_LINK_TOKEN" \
  --name    "build-box-1"           # optional; defaults to hostname
```

Re-running `init` over an existing config errors out by default. Pass
`--force` to overwrite. Note that `--force` mints a **new** machine ID:
the host rejoins the dashboard as a fresh machine, and projects and
sessions created under the old identity stay attached to it.

#### What gets discovered

On the next `argus-sidecar` boot the daemon probes `PATH` for every
adapter it knows about (`claude`, `codex`, `cursor-agent`, …) and
reports what it finds — adapter type, binary path, and `--version` —
back to the server. The dashboard's new-session picker will then list
only the adapters that actually exist on this host.

You don't pre-declare adapters or list them anywhere. Install the
CLI you want exposed (`brew install claude`, `npm i -g @openai/codex`,
…) and restart the sidecar; it will appear.

#### Where the cache lives

```
~/.config/argus/sidecar.json     # default
$XDG_CONFIG_HOME/argus/sidecar.json    # if XDG_CONFIG_HOME is set
$ARGUS_CONFIG_DIR/sidecar.json         # explicit override (highest priority)
```

Or pass `-cache /full/path/sidecar.json` to either subcommand for an
ad-hoc location (handy for system-wide installs at
`/etc/argus/sidecar.json`).

The file is small JSON — machine name + ID, bus URL, server link
credentials, and the project workdir allowlist. It's safe to inspect and
to back up. Everything else (host info, discovered adapters, sidecar
version) is recomputed on every boot, so a binary upgrade or a system
rename can't be driven from a stale snapshot. The allowlist is persisted
so the file jail and the fs watchers come up on reboot without waiting
for the server's reconcile broadcast.

### Step 7: Run the sidecar in the background

For development, just run it in a terminal:

```bash
argus-sidecar
```

Refresh the dashboard — the machine appears at the bottom of the
sidebar within ~1 second of startup. For production you want a
service manager so the process survives reboots and restarts on
crashes.

#### Recommended — let the sidecar install its own unit

```bash
argus-sidecar service install
```

One command on both platforms: it renders the unit (systemd on Linux,
launchd on macOS), writes it, reloads the manager, enables it and starts
it. Verify with `argus-sidecar service status`; undo with
`argus-sidecar service uninstall`.

It renders from live state rather than from a template you have to edit,
which removes the two failure modes the hand-written recipes below are
prone to:

- **`PATH`.** Adapter discovery is a `PATH` probe at boot. A service
  manager's default `PATH` is a bare `/usr/bin:/bin` — no
  `~/.local/bin`, no nvm shims, no Homebrew — so a unit that omits it
  starts cleanly and then reports zero adapters. `install` bakes in the
  `PATH` you invoked it with; `-path` overrides.
- **The install target.** A systemd `--user` unit must be
  `WantedBy=default.target`. `multi-user.target` is correct only for
  system units, and a user unit carrying it never starts at login.

Useful flags: `-dry-run` prints the unit without writing anything,
`-system` installs system-wide (needs root; `-user-account` picks the
account it runs as), `-cache` pins a cache path into `ExecStart`,
`-no-start` writes and enables without starting.

Scope defaults to per-user, which is almost always right: the sidecar
spawns agent CLIs that read your credentials, config and `PATH`. The
catch is that a user unit stops at logout unless lingering is enabled —
`install` checks and prints the `loginctl enable-linger` command if it
isn't.

You do not have to remember to restart it after an upgrade:
`argus-sidecar update` detects this service once it swaps the binary and
offers to restart it (`--restart` / `--no-restart` to decide up front).

The rest of this step documents what that command writes, for anyone who
wants to customise it or install the unit by hand.

#### macOS — launchd, by hand

Drop the following at `~/Library/LaunchAgents/com.argus.sidecar.plist`
(per-user) or `/Library/LaunchDaemons/...` (system-wide):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.argus.sidecar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/argus-sidecar</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/argus-sidecar.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/argus-sidecar.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict></plist>
```

Load it once:

```bash
launchctl load -w ~/Library/LaunchAgents/com.argus.sidecar.plist
launchctl list | grep argus
```

To restart after an `argus-sidecar update`:

```bash
launchctl kickstart -k gui/$UID/com.argus.sidecar
```

#### Linux — systemd, by hand

`/etc/systemd/system/argus-sidecar.service` (system-wide; for a `--user`
unit put it at `~/.config/systemd/user/argus-sidecar.service`, drop the
`User=` line and change `WantedBy` to `default.target`):

```ini
[Unit]
Description=Argus sidecar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=argus
ExecStart=/usr/local/bin/argus-sidecar run
# Required, not optional: without it systemd hands the daemon a bare
# /usr/bin:/bin and adapter discovery finds none of the agent CLIs
# installed under $HOME. List the dirs your CLIs actually live in.
Environment="PATH=/home/argus/.local/bin:/usr/local/bin:/usr/bin:/bin"
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now argus-sidecar
sudo journalctl -u argus-sidecar -f
```

Restart after update: `sudo systemctl restart argus-sidecar`.

#### Without a service manager

The sidecar ships its own background mode, which is what you want for
interactive use or a quick non-production install:

```bash
argus-sidecar start      # detach; logs to ~/.local/state/argus/sidecar.log
argus-sidecar status     # running pid, uptime, log + pidfile paths
argus-sidecar restart    # graceful stop + start
argus-sidecar stop       # SIGTERM, then SIGKILL after --timeout (default 10s)
```

State files live under `$XDG_STATE_HOME/argus/` (default
`~/.local/state/argus/`); override with `--pid-file` / `--log-file`. Both
this and the bare `argus-sidecar` take the same advisory `flock(2)` on
the pidfile, so you can't accidentally run two daemons against one cache
(which would share a `machineId` and confuse the server).

This survives the terminal but not a reboot — use `service install` above
for anything long-lived. The log is append-only; wire it into
`logrotate` or `newsyslog` if you want rotation.

### Step 8 — Verify and create your first session

1. Refresh the dashboard. The bottom of the sidebar grows a
  **machines** section with your host listed (green dot when
   reachable).
2. Hover the machine row and click the `+` to create a **project**:
  - **working dir** — the directory the CLI is launched in. It can't
   change later, because the CLIs key their `--resume` state on the cwd.
  - **name** — what you'll see in the sidebar.
  - **attach interactive terminal** — opt-in PTY (see the next
  section).
3. The project appears in the sidebar immediately. Hover it, click its
   `+`, pick an **adapter** (pre-filtered to what the sidecar discovered
   on `PATH`) and a name, then send a prompt — the response streams back
   token-by-token, with tool-call cards rendering inline.

A session pins to its project and CLI type for life; the server routes
each turn to that machine's runner for that CLI. Nothing is persisted on
the sidecar except the workdir allowlist, so a daemon restart needs no
operator action.

If the machine never appears, jump to [Troubleshooting](#troubleshooting)
below.

---

## Optional: enable the interactive terminal

The PTY is per-project, ticked at project-create time via the **attach
interactive terminal** checkbox. When enabled, the dashboard grows a
real PTY shell on that machine in the right-hand panel — full ANSI
colors, resize, ctrl-C, usable for `vim` / `htop` / anything. Traffic
flows over a direct sidecar↔server WebSocket (not Redis) so keystroke
echo stays sub-10 ms.

> **This is remote shell access** under whichever user runs the sidecar
> process. Only enable on hosts where every dashboard user is trusted
> with that level of access.

Two pieces of plumbing are required, both *server-side* — the sidecar
needs no extra config beyond what `init` already collected:

1. Set `SIDECAR_LINK_TOKEN` in the server's `.env` to a long random
  value (`openssl rand -hex 32`).
2. Pass the same value to `argus-sidecar init --token "..."` on each
  sidecar (or run `argus-sidecar init --force --token "..."` to add
   it to an already-initialized box).

Defaults the sidecar enforces on the PTY:

- Allowed shells: `$SHELL`, `/bin/bash`, `/bin/zsh`, `/bin/sh`.
- Max concurrent open PTYs per sidecar: 16.
- `cwd` defaults to the project's `workingDir` (set when you created the
project), falling back to the daemon's own CWD.

These can be overridden with environment variables on the sidecar
(`ARGUS_TERMINAL_SHELLS=/bin/zsh,/bin/bash` and
`ARGUS_TERMINAL_MAX=32`) — see
`packages/sidecar/internal/terminal/runner.go` for the full list.

---

## Updating


| Component       | How to update                                                                             |
| --------------- | ----------------------------------------------------------------------------------------- |
| `argus-server`  | `docker compose pull server && docker compose up -d server`. Migrations apply on boot.    |
| `argus-web`     | `docker compose pull web && docker compose up -d web`.                                    |
| `argus-sidecar` | `argus-sidecar update` (downloads, verifies, atomic swap, then offers to restart the running service). |


`:latest` follows `main`. For controlled upgrades, pin to `:X.Y.Z` in
the compose file and bump explicitly.

Server, web and sidecar ship as one release train — run the same minor
version across all three. Breaking changes between minors are called out
in the [GitHub release notes](https://github.com/kr4t0n/argus/releases);
read them before jumping a minor.

### Updating sidecars from the dashboard

You don't have to SSH into every host. The same self-update runs
remotely:

- **Per-machine** — open a machine's pane (click its row in the sidebar's
  machines list) and pick **Update sidecar** from the header kebab menu
  (⋮). A green badge appears whenever a host is running a sidecar older
  than the latest published release.
- **Whole fleet** — hover the **machines** header in the sidebar and pick
  **Update all sidecars…**. A modal previews which hosts will update,
  which are current, and which are offline (and therefore skipped). The
  run walks the fleet sequentially and stops on the first failure, so a
  bad release can't cascade.

The server publishes an `update-sidecar` command on the host's Redis
control stream; the sidecar reuses its normal update flow, then brings up
the new binary in whichever way fits how it was started — re-exec in
place (preserving the pid and its pidfile lock), a clean exit for
systemd/launchd to respawn, or a "restart needed" notice if it's attached
to a TTY. Active sessions reconnect across the restart, terminals
included. Set `GITHUB_TOKEN` in the server env so the release check
doesn't hit the unauthenticated rate limit.

### Removing a machine

Open the machine's pane and use **delete** (works at any status). This is
a **soft delete**: the machine and its projects disappear from the
dashboard, but nothing is destroyed — every session, command and result
stays in Postgres.

Reach that history through search (`⌘K` for content, `⌘P` to switch
sessions). Those sessions still list, still name the project and host
they ran on, and open with their full transcript; they're marked
**removed** and read-only.

The removal is sticky — a sidecar that keeps running or restarts is
ignored, so the machine will not reappear, and there is no un-delete in
the UI. The sidecar process itself is untouched; stop it with
`argus-sidecar stop` on the host if you're retiring it too. Running
`argus-sidecar init --force` there mints a new machine identity, so it
rejoins as a fresh machine and the old sessions stay with the removed one.

---

## API keys

The REST API is normally reached with a JWT from `POST /auth/login`. For
machine-to-machine callers, mint a **revocable API key** instead: it can
be revoked without rotating `JWT_SECRET` (which would log out every
user), and it can be restricted to read-only.

Manage keys from the dashboard's user panel, or over REST:

```bash
TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@argus.local","password":"…"}' | jq -r .token)

# readonly defaults to true; pass "readonly": false for a read/write key
curl -s -X POST "$API/auth/api-keys" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"dashboard"}'
# → {"id":"…","name":"dashboard","prefix":"argus_AbCd12","readonly":true,"key":"argus_…"}
```

The `key` is shown **once** — store it, it cannot be retrieved again.
Then call the API with it in the `X-API-Key` header:

```bash
curl -s "$API/sessions" -H "X-API-Key: argus_…"           # 200 — reads work
curl -s -X POST "$API/sessions" -H "X-API-Key: argus_…"   # 403 — read-only key
```

A read-only key is confined to `GET`/`HEAD`/`OPTIONS`. List keys with
`GET /auth/api-keys` and revoke one with `DELETE /auth/api-keys/:id`
(both JWT-only — an API key can't manage keys). A key acts as the user
who created it, so per-user data stays scoped to that account; create a
dedicated `viewer` user for an integration rather than tying it to your
admin login.

---

## Troubleshooting

`**prisma migrate deploy` fails with `P1000` or `P1001` on first boot.**
The DB is unreachable or credentials are wrong. Confirm `DATABASE_URL`
from the server container itself:
`docker compose exec server pnpm exec prisma db pull --schema prisma/schema.prisma --force`.

`**prisma migrate deploy` fails with permissions errors.**
The DB role lacks DDL privileges. Either use a role with `CREATE` /
`ALTER` rights for the initial migration, or run migrations once from a
privileged session and downgrade the runtime role.

**Server boots but no admin appears on first login.**
The bootstrap module only seeds when `ADMIN_EMAIL` is absent. If you
set the env vars *after* first boot, exec into the container and create
one manually with `pnpm exec tsx prisma/seed.ts` (note: `tsx` is dev-only
in the runtime image; the bootstrap path is the supported one — set the
env vars before first boot).

**Sidecar logs `connection refused` to Redis.**
Network/firewall. From the sidecar host: `redis-cli -u "$REDIS_URL" PING`.
For Upstash / managed services, double-check you're using the `rediss://`
scheme (TLS) and including the password.

**Machine registers, but turns hang forever with no output.**
Almost always a TTY-prompt problem in the wrapped CLI. The built-in
adapters set the right "skip approval prompts" flag by default
(`--dangerously-skip-permissions` for claude,
`--dangerously-bypass-approvals-and-sandbox` for codex, `--yolo` for
cursor) so this should never bite a stock install — but a CLI
configured to require approvals some other way (a global config file,
a wrapper script on `PATH`) will sit waiting for a TTY that doesn't
exist. Check the CLI runs non-interactively on that host by hand.

**Terminal pane shows "disconnected" immediately.**
`SIDECAR_LINK_TOKEN` mismatch between server and sidecar, or the sidecar
can't reach the server URL recorded by `argus-sidecar init`. Check the
server's logs for `sidecar-link rejected: bad token` and the sidecar's
logs for HTTP dial errors. Re-run `argus-sidecar init --force --token "..." --server "..."` to repair.

**The dashboard loads from a phone but sign-in fails with "load failed".**
You're hitting the API at the phone's own `localhost`. The bundled
`host.ts` derives the API URL from `window.location` — make sure you're
reaching the dashboard via a hostname or LAN IP that's also reachable
on `:4000`, not via `localhost:5173` from a different device.

**`argus-sidecar update` or the installer says `404 Not Found` against a
private repo.**
Neither the release feed nor the `/releases/download/` redirect is
readable without credentials on a private repo. Set
`GITHUB_TOKEN=<a-PAT-with-repo-read>` in the environment and re-run —
that also switches resolution to the authenticated Releases API, which
is the supported path for private repos.

**Installing or updating fails with `403` and "API rate limit
exceeded".**
`api.github.com` allows 60 unauthenticated requests per hour **per IP**,
and every machine behind the same NAT egress shares it — so a fleet
rollout can exhaust it partway through. Current versions do not touch
the API at all by default, so the fix is to upgrade the installer (the
`main` copy of `scripts/install.sh`) and the sidecar. If you need the
API path — private repo — set `GITHUB_TOKEN` for 5000 req/h. Note that
having `GITHUB_TOKEN` set in your environment *selects* the API path, so
an expired token turns a working install into this error.

**The machine goes green but the new-session picker lists no adapters.**
The sidecar is running without your shell's `PATH`. Adapter discovery is
a `PATH` probe at boot, and a service manager's default is a bare
`/usr/bin:/bin` — no `~/.local/bin`, no nvm shims, no Homebrew — so the
daemon starts cleanly, registers the machine, and finds none of the
CLIs. `argus-sidecar service install` bakes the invoking shell's `PATH`
into the unit; re-run it from a shell where `which claude` works, or
pass `-path`. If you wrote the unit by hand, add an explicit
`Environment="PATH=..."` (systemd) or an `EnvironmentVariables` → `PATH`
entry (launchd). The daemon logs what it found at boot — grep the journal or
`sidecar.log` for `discovery: found N adapter(s) on PATH`.

---

For deeper architectural background see [AGENTS.md](AGENTS.md). For the
feature overview and dev-mode setup see [README.md](README.md).