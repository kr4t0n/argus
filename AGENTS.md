# AGENTS.md

This file is the high-level map for AI agents (and humans) contributing to
**Argus**. Read it before making non-trivial changes; keep it in sync with the
actual code.

## Mental model

Argus has **four** moving parts and one wire format:

1. **Web (`apps/web`)** — single-page React app. Knows nothing about agents
   except via HTTP + WebSocket events.
2. **Server (`apps/server`)** — NestJS control plane. Owns Postgres, owns the
   WebSocket, brokers between the UI and the message bus.
3. **Sidecar (`packages/sidecar`)** — one Go binary per *machine*. The
   daemon registers itself as a `Machine`, discovers installed CLI
   adapters on `PATH`, and supervises N agent processes — each a
   wrapper around one CLI (`claude`, `codex`, `cursor-agent`, …)
   created from the dashboard. Identity & agent set are persisted to
   `~/.config/argus/sidecar.json` (see `internal/machine/cache.go`),
   not YAML.
4. **Transports** — two independent channels, split by workload:
   - **Redis Streams** (durable, at-least-once) for control-plane traffic:
     - `agent:lifecycle`        — machines announce/heartbeat themselves;
       sidecars also publish per-agent spawn/destroy acknowledgments here.
     - `machine:{mid}:control`  — server → sidecar daemon
       (`create-agent`, `destroy-agent`, `sync-agents`).
     - `agent:{id}:cmd`         — server → that agent's supervisor.
     - `agent:{id}:result`      — supervisor → server (chunks, externalId).
   - **Sidecar link** (direct WebSocket, path `/sidecar-link`) for terminal
     PTY traffic (open / input / resize / close / output / closed). This
     bypasses Redis because every keystroke-echo round-trip used to cost
     50-150 ms on a regional Redis (Upstash) and felt visibly laggy. See
     "Terminal latency budget" under Gotchas.

The wire format lives in `packages/shared-types/src/protocol.ts` and is
hand-mirrored in `packages/sidecar/internal/protocol/protocol.go`. **If you
change one, change the other.**

## Domain model

```
User ── owns ──▶ many Sessions
Session ── targets ──▶ one Agent
Session ── contains ──▶ many Commands (user turns)
Command ── emits ──▶ many ResultChunks (streamed)
```

- A **Machine** is a host running one `argus-sidecar` daemon. Owns its
  agents and reports its discovered adapters.
- An **Agent** is a worker — a single CLI wrapper supervised by some
  machine's daemon. "Who can do work." Server-managed: created and
  destroyed from the dashboard, persisted to Postgres, and pushed down
  to the owning machine over its control stream.
- A **Session** is a conversation thread targeting one agent. It maps 1-1 to
  the underlying CLI's native conversation id (Claude Code `--resume`, Codex
  `resume`, Cursor CLI `--resume`) via `Session.externalId`. The server stores
  the `externalId` after the sidecar reports it on the first turn.
- A **Command** is a single user turn within a session.
- A **ResultChunk** is one streamed fragment: `delta`, `tool`, `stdout`,
  `stderr`, `progress`, `final`, or `error`.

`delta` chunks carry incremental text and are the source of the typewriter
effect. The viewer concatenates them per-command in `(commandId, seq)` order.

## Module responsibilities

### `apps/server/src/modules/`

- `auth/` — JWT login, single admin user bootstrapped from env.
- `machine/` — owns the `Machine` table and the agent control plane.
  Consumes `agent:lifecycle` (`machine-register`, `machine-heartbeat`,
  `agent-spawned`, `agent-spawn-failed`, `agent-destroyed`), upserts
  `Machine` rows, replies with a `sync-agents` reconcile so the
  sidecar's cached agent set converges with the server's. Exposes
  REST (`GET /machines`, `POST /machines/:id/agents`,
  `DELETE /machines/:id/agents/:agentId`) and emits `machine:upsert`
  / `machine:status` / `machine:removed` / `agent:spawn-failed` over
  WS. Also publishes `create-agent` / `destroy-agent` commands on
  `machine:{mid}:control`.
- `agent-registry/` — `Agent` CRUD: list, get, archive/unarchive, plus
  the shared `agentToDto` mapper. Lifecycle ingestion lives in
  `machine/`; this module is purely about the persisted Agent row.
- `session/` — CRUD for sessions; resolves `externalId` so each subsequent
  turn carries it back to the sidecar for `--resume`.
- `command/` — persists commands, `XADD`s to `agent:{id}:cmd`, handles cancel.
- `result-ingestor/` — single XREADGROUP across **all** agent result streams
  (refreshed every 5s). Persists each chunk and **immediately** forwards to
  WS room `session:{sessionId}` (no batching — the typewriter UX needs it).
  Also flips command/session status on `final`/`error`.
- `terminal/` — interactive PTY plumbing. Owns the `Terminal` row, exposes
  REST (`POST/GET /agents/:id/terminals`, `DELETE /terminals/:id`), a WS
  subgateway for `terminal:input` / `terminal:resize` / `terminal:close`,
  and a `TerminalLinkBridge` that routes inbound `SidecarLinkService`
  frames (output, closed) back to the browser WS and the DB. When the
  sidecar link drops, the bridge force-closes all of that sidecar's
  open terminals so the UI doesn't show zombies. Bytes are base64 over
  the wire to survive JSON. A small in-memory cache keyed by terminalId
  short-circuits Postgres ownership checks on every keystroke.
- `sidecar-link/` — raw WebSocket server on path `/sidecar-link`
  attached to the same `http.Server` as NestJS (via `HttpAdapterHost`,
  `noServer` pattern). Owns one connection per sidecar, validates a
  shared-secret `SIDECAR_LINK_TOKEN`, and exposes `send(sidecarId,
  frame)` / `onFrame(...)` / `onDisconnect(...)` hooks to the terminal
  module. Pings every 15 s, idle-timeout after 45 s.
- `gateway/` — Socket.IO namespace `/stream`. Rooms: `user:{id}`,
  `agent:{id}`, `session:{id}`, `terminal:{id}`. Authenticates the handshake
  using the same JWT used for REST. The gateway is the **only** thing that
  emits live data to clients.
- `infra/redis/` — wrapper that owns *two* connections: one for blocking
  XREADGROUP, one for everything else (ioredis requires this).
- `infra/prisma/` — Prisma client.

### `packages/sidecar/internal/`

- `cmd/sidecar/` — entrypoint and CLI. `main.go` dispatches to subcommands
  (`init`, `update`, `version`, `start`/`stop`/`restart`/`status`, plus the
  bare/`run` foreground daemon). `daemonize.go` re-execs the binary with a
  `__daemon` sentinel arg under `setsid` and dups stdout/stderr onto
  `$XDG_STATE_HOME/argus/sidecar.log` for `start`. `pidfile.go` resolves the
  pidfile + log path under `$XDG_STATE_HOME/argus/` and takes an exclusive
  `flock(2)` that is the *single source of truth* for "is a daemon running?"
  — both the foreground and the spawned child grab it at boot, so two
  sidecars can never share one cache (and therefore one `machineId`).
  `control.go` implements `stop` (SIGTERM → wait `--timeout` → SIGKILL),
  `status` (LSB exit codes: 0 running, 1 stale pidfile, 3 stopped), and
  `restart`. None of the control verbs touch Redis or the server — they
  operate purely on the local pidfile + process table, which keeps them
  fast and useful even when the network is down.
- `protocol/` — wire structs (mirror of shared-types).
- `machine/` — daemon, on-disk cache, and adapter discovery.
  - `cache.go` persists `~/.config/argus/sidecar.json` (machine id,
    bus URL, server link credentials, canonical agent list) with an
    atomic write so a sidecar restart re-spawns every supervisor
    *instantly*, without waiting for the server's reconcile broadcast.
  - `discovery.go` walks the registered adapter set, runs `exec.LookPath`
    on each `DefaultBinary`, and probes `--version`. The result is
    reported in `MachineRegisterEvent.adapters` so the dashboard can
    filter the "create agent" dropdown to what's actually installed.
  - `daemon.go` is the long-lived process: registers the machine,
    heartbeats, subscribes to `machine:{mid}:control`, fans
    create/destroy/sync commands out to per-agent `supervisor`s, and
    holds the single sidecar↔server WebSocket on behalf of all agents
    on this host.
  - `supervisor.go` owns one agent: builds the adapter, pings it once,
    drains `agent:{id}:cmd`, dispatches to the adapter, forwards
    chunks back on `agent:{id}:result`, heartbeats, and gracefully
    drains on destroy. There is no per-agent process — supervisors are
    goroutines inside the single daemon.
  - `fs.go` / `fswatch.go` / `git.go` — workingDir browsing for the
    dashboard's right-pane file tree. `ListDirs` BFS-walks up to
    `maxDepth` levels (reusing a single `listDirWith` core + one
    preloaded gitignore matcher) and returns a `path → entries` map
    so depth-N prefetch lands in one round trip. Both jail to the
    agent's workingDir, always strip `.git`, and respect gitignore.
    `fsWatcher` registers one fsnotify watch per non-ignored dir and
    coalesces events into 250 ms-debounced fs-changed emits. `git.go`
    reads `.git/HEAD` (and resolves the worktree-pointer file form)
    without shelling out to `git` or pulling in a Go git lib — its
    output is attached to every fs-list response so the dashboard's
    branch badge refreshes for free on every tree refetch.
- `bus/` — go-redis wrapper with `Publish`, `EnsureGroup`, `ReadMessage`, `Ack`.
- `adapter/` — `Adapter` interface and process-level **registry**. Each
  adapter file calls `Register(type, &Plugin{Factory, DefaultBinary})`
  from `init()` so discovery can find the binary by name on `PATH`.
  Built-in adapters that report `--version` implement the optional
  `Versioned` interface (see `util.ReadBinaryVersion`); the daemon
  prefers the auto-detected string over anything baked in.
- `sidecarlink/` — gorilla/websocket client that dials
  `ws://{server.url}/sidecar-link`, performs a `hello`/`hello-ack`
  handshake, and exposes `Publish(frame)` + `Inbound()`. Reconnects
  with exponential backoff (0.5 s → 30 s cap), pings every 15 s with a
  40 s pong timeout, serializes writes with a mutex. The inbound
  channel uses drop-oldest backpressure to keep the read loop from
  stalling pongs if a downstream consumer is slow.
- `terminal/` — PTY runner using `github.com/creack/pty`. Consumes
  control frames from the `Link` (a `sidecarlink.Client`) instead of a
  Redis stream, multiplexes per-terminal goroutines (read pump +
  wait-for-exit), and publishes output frames back over the same link
  with an **adaptive flush**: single keystrokes flush immediately
  (`idleGap` detection), active bursts get a 4 ms debounce, and 16 KB
  caps a single frame. Decoupled from any global config: takes a
  `Settings` struct (shells, max-sessions) and an `AgentLookup`
  interface so it can validate `terminal:open` against the daemon's
  live agent registry (`Agent.supportsTerminal`, `Agent.workingDir`).
- `updater/` — self-update: reads the GitHub Releases API for
  `argus-sidecar-v*` tags, picks the matching `OS-arch` asset,
  verifies it against `SHASUMS256.txt`, and atomically `os.Rename`s
  over the running binary. Drives both `argus-sidecar update` (CLI)
  and remote `update-sidecar` commands from the dashboard
  (`machine/update.go`). On the remote path the daemon detects its
  restart mode (`self`, `supervisor`, `manual` — see the gotcha
  below) and either re-execs in place via `syscall.Exec`, exits 0
  for systemd/launchd, or stays put and asks the operator to
  restart manually.
- `cmd/sidecar/main.go` — subcommand dispatch (`init`, `update`,
  `version`, default = run daemon), flag parsing, signal handling,
  runner glue.

### `apps/web/src/`

- `lib/api.ts` — typed REST client.
- `lib/ws.ts` — single Socket.IO connection with reconnect; broadcasts events
  to a small set of subscribed handlers.
- `stores/` — Zustand slices: `authStore`, `agentStore`, `sessionStore`,
  `uiStore`. Sessions are stored by id with their full `chunks` buffer; the
  WS pushes new chunks via `appendChunk`, which guards duplicates by `id`.
- `components/StreamViewer.tsx` — the streaming display. Groups chunks by
  command, concatenates `delta`s, renders tool pills, stdout, errors, and a
  cursor while running.
- `components/TodoWindow.tsx` — per-turn task tracker rendered inside the
  sticky band right under `<ActivityPill>`. Sources its rows from the
  *latest* `TodoWrite`-style tool chunk in the command's chunks
  (`meta.tool ∈ {todowrite, todo, task}`, `meta.input.todos`); each call
  replaces the full list, no merging. Open by default, user-collapsible
  via the chevron — there is intentionally no auto-collapse when all
  todos complete (we want the finished plan to stay visible next to the
  assistant's answer). Returns null for codex sessions / any turn
  without a TodoWrite chunk. Shape parsing is deliberately defensive —
  see the AGENTS.md note on stream-json drift.
- `components/Sidebar.tsx` — agent-first tree: each agent is a top-level row
  with its sessions nested underneath and a `+ new session` affordance.
- `components/TerminalPane.tsx` — xterm.js bound to one agent. Owns the
  WebSocket plumbing, a debounced ResizeObserver for fit, base64 encoding
  on input, and a duplicate-seq guard on output. Lives in a collapsible
  section inside `ContextPane` so we don't pay the xterm cost until the
  user clicks "open".

## Conventions

- **Path alias**: `@argus/shared-types` resolves to the package's source
  (Vite + tsconfig paths). Don't import from compiled `dist/` directly.
- **Status vocab**: agents use `online | busy | error | offline`; sessions
  use `active | idle | done | failed`; commands use the lifecycle in the
  Prisma schema (`pending|sent|running|completed|failed|cancelled`).
- **IDs**: sessions and commands use `cuid()`. Machine ids are minted
  once by `argus-sidecar init` and persisted to the cache (regenerated
  only with `init --force`). Agent ids are server-issued at create
  time and replayed back to the sidecar via `create-agent` /
  `sync-agents`. Both are stable across restarts on both sides.
- **At-least-once delivery**: chunks may be redelivered after a server
  restart. The store de-dups by chunk `id`; the DB write swallows unique-key
  collisions.
- **WS rooms**: clients join `session:{id}` to receive that session's chunks
  and `command:*`/`session:*` updates. The server emits `agent:*` to
  everyone; per-user events go to `user:{id}` only.
- **Streaming over batching**: never coalesce `delta` chunks server-side.
  Drop only when a *specific* socket is lagging (TODO — see follow-ups).

## Gotchas

- **Prisma + workspace import**: the server can only typecheck if `rootDir`
  is unset, because `@argus/shared-types` lives outside `apps/server/src`.
  `nest build` is fine because it only compiles `src/`.
- **Adapter `init()`**: an adapter only registers itself if its file is
  *imported*. The blank `_ "..."` trick isn't needed today because they're
  all under the same package, but keep it in mind when adding adapters in a
  separate package.
- **Two Redis connections**: do **not** call `XREADGROUP` on the shared
  `cmd` ioredis client — it parks the socket and starves every other call.
- **Stream MAXLEN is silent message loss, not just memory pressure**:
  every `XADD` on both sides (`apps/server/src/infra/redis/redis.service.ts`
  and `packages/sidecar/internal/bus/bus.go`) trims with `MAXLEN ~ N`,
  where N is per-stream and looked up from `streamMaxLen` in
  `packages/shared-types/src/protocol.ts` (mirrored as `StreamMaxLen`
  in `packages/sidecar/internal/protocol/protocol.go` — keep both in
  sync). If trimming runs before a consumer `XACK`s an entry, that
  entry is **gone** — the pending-entries list still references its
  ID but `XREADGROUP` can never replay it. Symptoms: missing result
  chunks mid-command, a sidecar that "didn't get" a control message,
  unrecoverable PEL growth. Current caps are sized for a ~30 MB Redis
  with ~10 agents: `agent:lifecycle`=500, `agent:{id}:cmd`=200,
  `agent:{id}:result`=500, `machine:{id}:control`=200. If you scale
  past that — more agents, chunkier terminal output, longer expected
  consumer outages — bump the relevant entry in *both* helpers and
  re-budget against your Redis `maxmemory`. The `~` operator means
  Redis trims lazily on listpack boundaries, so actual stored length
  can briefly exceed N; that's the budget headroom, not slack to
  rely on.
- **stream-json drift**: each CLI's NDJSON event shape changes between
  versions. The mappers (`mapClaudeLine`, `mapCodexLine`) are
  defensive — unknown events fall through as `progress` chunks rather than
  crashing.
- **File-edit diffs**: every adapter (Codex, Claude Code, Cursor CLI)
  shares the snapshot-then-diff machinery in
  `packages/sidecar/internal/adapter/filediff.go`. The flow is uniform:
  on the tool *start* event the adapter calls
  `state.RememberBefore(toolID, absPath)` to snapshot the file, and on
  the matching tool *result* event it calls `state.BuildDiff(toolID,
  kind)` which re-reads the file and returns a unified diff. The diff
  is emitted as the result chunk's content with `meta.isDiff: true`,
  which the web UI (`DiffBlock` in `ToolPill.tsx`) renders with
  per-line colors. Snapshots are scoped to a single Execute() and use
  256 KiB / NUL-byte / 400-line caps to keep payloads sane. If a
  snapshot fails (binary, too big) we silently fall back to the
  adapter's plain-text result. When adding a new adapter, identify
  its file-modifying tools (see `isFileEditTool` in `claude_code.go`
  for the canonical list) and call the same two `fileEditState`
  methods — do **not** re-implement diffing per adapter.
- **Token-level UI re-render**: `StreamViewer` concatenates all `delta`s
  into a single string per command and re-renders that block on every chunk.
  This is fast enough up to a few hundred KB; if you hit perf issues,
  switch to an append-only DOM strategy.
- **Auth on the WS handshake**: the JWT is read from `auth.token`. We don't
  ship per-event RBAC yet — anyone with a valid token sees everything.
- **`getSessionChunks` re-fetch on reconnect**: the client passes
  `afterSeq=lastSeq`; the server's REST endpoint hits Postgres, not Redis,
  so it works even after Redis stream trimming.
- **Archive vs destroy vs delete**: agents, sessions, and machines all
  support soft-archive via an `archivedAt DateTime?` column —
  `POST /agents/:id/archive` / `POST /sessions/:id/archive` hide rows
  from default lists without losing history. Pass
  `?includeArchived=true` to bring them back.
  *Hard-destroy* an agent via `DELETE /machines/:mid/agents/:agentId`:
  the server publishes a `destroy-agent` command, the sidecar tears
  the supervisor down and drops the cache entry, and the row is
  removed from Postgres (cascading via `onDelete: Cascade` on
  Session/Command/Result). This is the supported way to delete an
  agent — the sidebar's per-agent "trash" hits this. There is no
  separate destroy for sessions; archive and re-create instead.
  Machine rows are not user-deletable: stale machines are reaped by
  the periodic sweeper after a grace window and their agents
  destroyed alongside.
- **Terminal == remote shell access**: ticking "attach interactive
  terminal" when creating an agent lets *any* dashboard user spawn
  shells on that host as the sidecar daemon's UID. Treat this as equivalent to handing out SSH; only
  enable on hosts where every dashboard user is trusted to that level.
  Hardening hooks: the sidecar enforces a `shells` allowlist and a
  `maxSessions` cap; the server REST/WS layer requires JWT, scopes
  terminals to the opening user (`requireOwned`), and the `Terminal`
  table is an audit trail (open/close timestamps, exit codes).
- **Terminal latency budget**: terminal traffic flows
  browser → server-WS → **sidecar link (WS)** → sidecar → PTY →
  sidecar → **sidecar link (WS)** → server → browser-WS. Keystroke
  echo on a local host measures ~2 ms p50, ~6 ms p99 — usable for
  full-screen TUIs (`vim`, `htop`, `less +F`). The previous
  Redis-Streams transport measured 50-150 ms p50 on Upstash (regional),
  which is why the direct link exists. Commands and session results
  still ride Redis Streams — those don't sit on the hot path and
  benefit from Streams' durability/replay semantics. If you ever need
  to re-introduce a Redis fallback for terminals, wire it behind a
  config flag in `TerminalService.open/input/resize/close` and keep
  the frame kinds identical.
- **Sidecar link authentication**: the `/sidecar-link` WS uses a
  shared-secret token (`SIDECAR_LINK_TOKEN` on the server, recorded by
  `argus-sidecar init --token` on the sidecar side). If the server env var is empty the
  endpoint accepts any caller — fine for local dev, loudly logged on
  boot, **do not** ship that way. The token is compared with plain
  string equality; it only protects against external attackers
  reaching `/sidecar-link`, not against a compromised sidecar host
  (which trivially has shell access anyway).
- **Sidecar link drop semantics**: when a sidecar's WS drops, the
  server force-closes every `opening|open` terminal for that agent
  with reason `"link disconnected: ..."`. We do NOT try to resume
  PTYs across reconnects — the bytes buffered on the sidecar side
  during the outage would desync from the browser's xterm state and
  the rehydration logic is not worth the complexity. Users just
  re-open a terminal when the sidecar comes back.
- **Terminal transcripts are not persisted**: the `Terminal` row stores
  metadata only — never the keystroke/output transcript. Adding one
  would balloon storage fast and risks capturing secrets typed into the
  shell. If you need replay, add a separate, opt-in `TerminalTranscript`
  table gated behind a per-agent flag (mirror the existing
  `supportsTerminal` plumbing).
- **Machine icons live on the Machine row, not in localStorage**: the
  picker in `MachineIcon.tsx` writes to `Machine.iconKey` via PATCH
  `/machines/:id/icon`, and the server emits `machine:upsert` so every
  connected dashboard re-renders the glyph in lockstep. We migrated
  this off `useUIStore.machineIcons` (localStorage-backed) so a user's
  picks roam between devices and teammates see the same icons. A
  one-shot helper (`apps/web/src/lib/migrateMachineIcons.ts`) runs
  on the first authenticated boot after the upgrade, pushes any
  leftover localStorage entries to the server (only when the
  server-side `iconKey` is still null — local never clobbers
  remote), then strips the field out of `argus.ui` so the helper is
  effectively idempotent on subsequent loads.
- **Remote sidecar update — restart mode is auto-detected, not chosen**:
  the dashboard's `Update sidecar` action publishes
  `update-sidecar` on the host's Redis control stream. The sidecar
  re-uses `internal/updater` to fetch + verify + atomically rename
  the new binary, then picks one of three handoff strategies
  *itself* based on environment hints — the server has no say:
    - **`self`**: nothing supervises us. The daemon `syscall.Exec`s
      the freshly installed binary in-place. PID stays the same and
      the `flock(2)` hold on the pidfile is preserved across `exec`
      (BSD flock semantics: the lock is per-fd, fd survives exec
      because we don't set `FD_CLOEXEC`). This is the **only**
      strategy where there's literally zero gap during which a stale
      `argus-sidecar start` could squeeze in.
    - **`supervisor`**: detected via `INVOCATION_ID` /
      `NOTIFY_SOCKET` (systemd) or `XPC_SERVICE_NAME` (launchd). The
      daemon releases the pidfile lock and `os.Exit(0)`s; the
      supervisor respawns the unit which picks up the new bytes.
    - **`manual`**: stdin/stderr is a TTY (a developer running
      `argus-sidecar` in the foreground). The daemon does NOT
      restart — it logs a notice and the dashboard's toast surfaces
      "restart needed" so the operator can ^C and re-run.
  Bulk-update (`POST /machines/sidecar/update-all`) walks the fleet
  sequentially and stops on the first failure so a bad release
  doesn't cascade across every host. Per-machine single-flight is
  enforced server-side (`SidecarUpdateService.machineLocks`); a
  click + bulk run targeting the same machine simply 400s the
  loser. The "update available" badge polls
  `GET /machines/:id/sidecar/version`, which is backed by a
  30-minute in-process cache of the latest GitHub release tag —
  set `GITHUB_TOKEN` on the **server** to dodge the
  unauthenticated rate limit when the badge fans out across many
  dashboards.
- **Terminal output binary safety**: PTYs emit raw bytes (escape
  sequences, control chars, partial UTF-8 across read boundaries). We
  base64-encode `data` in both directions so JSON serialization can't
  corrupt them. The xterm.js side decodes back to bytes via `atob` and
  hands them to `term.write` — do NOT try to be clever and decode as
  UTF-8 strings server-side, you'll mangle multibyte chars at chunk
  boundaries.
- **`docker-publish.yml` cache scoping**: builds are split per-image
  per-platform across native runners (`ubuntu-latest` for amd64,
  `ubuntu-24.04-arm` for arm64) — no QEMU. Each leg writes to a
  cache scope keyed by `<image>-<platform>` so the four parallel
  jobs never overwrite each other's BuildKit manifest in the GHA
  cache backend. A separate `merge` job per image then assembles the
  multi-arch manifest list with `buildx imagetools create` from the
  per-arch digests. If you ever rejoin the matrix, drop the cache
  scope back to `<image>` only or you'll silently halve cache
  hit-rate (the per-platform scopes won't be read by a combined
  build).
- **`detectRestartMode` must use `term.IsTerminal`, not `os.ModeCharDevice`**:
  the daemon child of `argus-sidecar start` has its stdin dup2'd to
  `/dev/null`, which *is* a character device — so the original
  `(st.Mode() & os.ModeCharDevice) != 0` check classified backgrounded
  sidecars as foreground TTYs and silently demoted them to `manual`
  restart mode. Net effect: remote updates downloaded the new binary
  but the running process never reloaded. Fixed in
  `argus-sidecar-v0.1.6` by switching to the proper TTY ioctl via
  `golang.org/x/term`. Pinned by
  `internal/machine/update_test.go:TestDetectRestartMode_DaemonChildIsSelf`
  — if you ever rewrite this with a homegrown FD check, run that test
  first.
- **Context-window lookup is hand-maintained**: the donut on the
  session header's `UsageBadge` reads its denominator from
  `packages/shared-types/src/contextWindow.ts`, a hardcoded family →
  window map matched by lowercased substring on the active model id.
  The "current context used" numerator is the LATEST `final` chunk's
  `inputTokens + cacheReadTokens + cacheWriteTokens` — not a sum across
  turns — because each CLI re-sends the full history on `--resume`,
  so the most recent prompt size IS the live context. When a new model
  family ships (Anthropic / OpenAI / Cursor announcement), bump the
  table as `chore(shared): update model context windows` — verify
  against the upstream announcement, not release-note rumors. Unknown
  models return `null` so the ring just hides instead of rendering a
  misleading percentage; the bare ↑/↓ arrows stay visible.
- **GHA cache budget cap**: GitHub enforces ~10 GB of cache per repo.
  Buildx with `mode=max` writes every intermediate stage; tag pushes
  (`refs/heads/refs/tags/v*`) write under their own ref scope and are
  unreadable from `main`, but still count toward the cap. Old PR
  caches also linger forever unless explicitly deleted. When the
  effective hit-rate degrades, sweep with
  `gh api /repos/<o>/<r>/actions/caches?ref=refs/pull/<n>/merge` →
  `DELETE`.

## Tech debt / planned

- Per-socket backpressure for `delta` chunks (drop-on-lag).
- Real RBAC and multi-tenant isolation.
- OpenTelemetry traces from web → server → sidecar (we already log structured).
- Pool routing (`agents.{type}.commands` consumer group) for "any agent of
  type X" — the protocol/streams support it; the dashboard doesn't expose it
  yet.
- Pre-commit hooks (ruff/eslint).

## When you change something

- **Wire format** → update `packages/shared-types/src/protocol.ts` **and**
  `packages/sidecar/internal/protocol/protocol.go`.
- **Streaming UX** → update `StreamViewer.tsx` and (if you add a new chunk
  kind) every adapter mapper that should emit it.
- **DB schema** → add a Prisma migration, regenerate the client, and update
  the relevant DTO mappers (`AgentRegistryService.toDto`, `SessionService.toDto`,
  `CommandService.toDto`).
- **Architecture** → update this file.
