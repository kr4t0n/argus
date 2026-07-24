# AGENTS.md

This file is the high-level map for AI agents (and humans) contributing to
**Argus**. Read it before making non-trivial changes; keep it in sync with the
actual code.

## Mental model

> **Status: the agent→runner refactor is complete** (docs/plan-agent-to-runners.md).
> The `Agent` entity is fully retired — there is no `Agent` table, no
> per-agent supervisor, and no `agentId` anywhere on the wire. Sessions
> route **by `projectId` → machine + `cliType` → runner stream**. The whole
> fleet runs runner sidecars (≥ 0.3); the pre-runner protocol has been
> deleted. Read the current model below, not any lingering "agent worker"
> phrasing you find deeper in this file.

Argus has **four** moving parts and one wire format:

1. **Web (`apps/web`)** — single-page React app. Knows nothing about the
   backend except via HTTP + WebSocket events.
2. **Server (`apps/server`)** — NestJS control plane. Owns Postgres, owns the
   WebSocket, brokers between the UI and the message bus.
3. **Sidecar (`packages/sidecar`)** — one Go binary per *machine*. The
   daemon registers itself as a `Machine`, discovers installed CLI
   adapters on `PATH`, and runs **one runner per installed CLI** (`claude`,
   `codex`, `cursor-agent`) — each a long-lived goroutine that dispatches
   turns for every session of that CLI type on this host. There are no
   per-session/per-agent processes. Identity + the project workdir
   allowlist are persisted to `~/.config/argus/sidecar.json` (see
   `internal/machine/cache.go`), not YAML.
4. **Transports** — two independent channels, split by workload:
   - **Redis Streams** (durable, at-least-once) for control-plane traffic:
     - `lifecycle`               — machines announce/heartbeat themselves
       (`machine-register` / `machine-heartbeat`) and reply with fs/git RPC
       responses. (`streamKeys.lifecycle`; the historical Redis key name
       predates the refactor.)
     - `agent:notify`            — fs-changed / git-changed watcher nudges.
       Split off from `lifecycle` so a build-burst of fs events can't
       MAXLEN-trim unread heartbeats (which flips healthy machines offline).
       Drained by the same MachineService XREADGROUP as `lifecycle`.
       `git-changed` has exactly ONE producer — the per-workdir
       `gitWatcher` — and that is a deliberate invariant, not an
       accident of history; see the `vcs_state_changed` gotcha before
       adding a second.
     - `agent:background`        — `argus-bg` task progress (see the
       background-task service note under Server modules).
     - `machine:{mid}:control`   — server → sidecar daemon
       (`sync-projects` — the full workdir allowlist — plus fs/git/model
       RPC requests and sidecar-update commands).
     - `machine:{mid}:cli:{type}:cmd` / `:result` — server → runner /
       runner → server (chunks, externalId), one pair per machine ×
       installed CLI. This is the ONLY command/result routing; the old
       per-agent `agent:{id}:*` streams are gone.
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
Session ── pinned to ──▶ one Project (machine + workingDir) + a cliType
Session ── contains ──▶ many Commands (user turns)
Command ── emits ──▶ many ResultChunks (streamed)
```

- A **Machine** is a host running one `argus-sidecar` daemon. It reports
  its discovered CLI adapters and runs one runner per installed CLI.
- A **Project** is a `(machineId, workingDir)` pair — the unit sessions
  group and route under. Sessions pin to a `Project` row at creation
  (`Session.projectId`) plus a `cliType`; the server resolves
  `projectId → machine + cliType → runner stream` when dispatching. There
  is no "agent" between the session and the runner.
- A **Session** is a conversation thread pinned to one project + cliType.
  It maps 1-1 to the underlying CLI's native conversation id (Claude Code
  `--resume`, Codex `resume`, Cursor CLI `--resume`) via
  `Session.externalId`. The server stores the `externalId` after the
  sidecar reports it on the first turn.
  `Session.modelSelection` (nullable JSON) holds the session-default
  `ModelSelection` (`{model, effort, context, speed}`); NULL means "CLI
  default" — no model flags are passed, the pre-picker behavior.
- A **Command** is a single user turn within a session. At dispatch the
  session's `modelSelection` is merged under any per-turn `options`
  (per-turn wins key-by-key) and the merged result is snapshotted on
  `Command.options` so history can answer "which model ran this turn?".
- A **ResultChunk** is one streamed fragment: `delta`, `tool`, `stdout`,
  `stderr`, `progress`, `final`, or `error`.

`delta` chunks carry incremental text and are the source of the typewriter
effect. The viewer concatenates them per-command in `(commandId, seq)` order.

## Module responsibilities

### `apps/server/src/modules/`

- `auth/` — credentials and the request guard. Two credential types both
  resolve to a `{ id, email, role }` user on `req.user`:
  - **JWT** — human login. `POST /auth/login` (email/password, single admin
    bootstrapped from env) returns a `token`; lifetime is `JWT_EXPIRES_IN`
    (default `7d`; `"never"`/empty mints a token with no `exp`).
  - **API key** — machine/integration callers, sent as the `X-API-Key`
    header. Revocable (`revokedAt`) without rotating `JWT_SECRET`, optionally
    expiring, and `readonly` by default. Only a SHA-256 hash is stored in the
    `ApiKey` table (fast hash is fine — keys are high-entropy, not passwords);
    the plaintext is shown once at mint. Managed via `POST`/`GET`/`DELETE
    /auth/api-keys`, which are **JWT-only** (`requireHuman`) so a leaked key
    can't mint successors or list siblings.

  `JwtAuthGuard` (historical name — it now guards both) checks `X-API-Key`
  first and otherwise falls back to the JWT bearer path. For a `readonly` key
  it rejects any non-`GET`/`HEAD`/`OPTIONS` request with 403 — that *is*
  "read-only", since Argus has no route-level RBAC (the only authz beyond a
  valid credential is per-row ownership checks). The guard depends on
  `ApiKeyService`, so `AuthModule` is `@Global()` to keep it resolvable in
  every feature module that does `@UseGuards(JwtAuthGuard)`. The web user
  panel (`apps/web/src/pages/UserPanel.tsx`, "API keys" section) drives the
  management endpoints — create with a read-only toggle, one-time secret
  reveal + copy + live "test" call, and inline-confirm revoke.
- `terminal/` — PTY sessions, addressed by (machine, cwd). `POST|GET
  /projects/:id/terminals` is the only route. The `Terminal` row carries
  `machineId` (the sidecar link's routing key — the keystroke hot path
  reads it straight off the row) plus `projectId`. Capability is
  `Project.supportsTerminal`; the runner opens the PTY by cwd. A
  pre-runner (< 0.3) sidecar has no runner to open one on, so the open is
  rejected early with a clear 400 (`isRunnerSidecar` gate) — but the whole
  fleet is ≥ 0.3, so that path is defensive only.
- `machine/` — owns the `Machine` table and the machine control plane.
  Consumes `lifecycle` (`machine-register`, `machine-heartbeat`, plus the
  fs/git/model RPC responses) and `agent:notify` (`fs-changed` /
  `git-changed`) in one XREADGROUP — same group name registered on both
  streams, shared handler switch. Batches are processed as units
  (`processBatch`): no-DB handlers (RPC responses, nudges) run first,
  heartbeats are coalesced newest-per-machine into grouped `updateMany`
  writes, and the whole batch is acked with one variadic XACK — see the
  "Lifecycle consumer throughput" gotcha before adding per-entry awaits
  back. Upserts `Machine` rows, replies to each (re)register with an
  idempotent `sync-projects` workdir-allowlist snapshot so the sidecar's
  fs/git jail + watcher registry converge with the server's set of known
  projects. Exposes REST (`GET /machines`, `DELETE /machines/:id`,
  `GET /machines/:id/models`) and emits `machine:upsert` /
  `machine:status` / `machine:removed` over WS. Command dispatch gates on
  machine status (`command.service.ts`). The machine-heartbeat is the
  only presence signal — runner sidecars have no per-agent heartbeats.
- `project/` — server-side metadata for "projects" (the
  `(machineId, workingDir)` pair the sidebar groups sessions
  under). Since Phase 1 of the agent→runner refactor
  (docs/plan-agent-to-runners.md) the `Project` row is the anchor
  sessions pin to: `Session.projectId` + `Session.cliType` are set
  at creation (rows upserted lazily by session-create and by the
  icon path) and backfilled for pre-existing sessions. Sidebar
  *placeholders* are still client-only (`useProjectStore`) — that
  promotion is deferred, see the plan's Phase 1 note. `GET
  /projects` hydrates the dashboard's icon map; `PATCH
  /projects/icon` upserts by `(machineId, workingDir)` (404s for
  deleted machines, keeps the row with `iconKey` NULL on reset)
  and broadcasts the DTO via the global `project:upsert` WS event.
- **The Agent entity is fully retired (docs/plan-agent-to-runners.md).**
  There is no agent runtime concept, no `Agent` table, and no `agentId`
  anywhere — on the wire, in the DB, or in any client. Sessions route by
  `projectId` → machine + `cliType` → runner stream
  (`SessionService.resolveRouting` — projectId-only), created
  project-first. The sweep dropped, in order: the agent-addressed REST +
  registry (Phase 4); the `Session.agentId` / `Command.agentId` /
  `Terminal.agentId` FK columns + `agentId` from the DTOs and wire
  `Command` (Phase 5, after `SELECT count(*) FROM "Session" WHERE
  "projectId" IS NULL` = 0); the `Machine.agentCount` field and the
  `Agent` table itself (Phase 6, migrations `9_phase6_drop_agent_table`);
  and finally the legacy per-agent lifecycle protocol + every residual
  `agentId` attribution echo (fs/git/bg-task events, RPC response frames,
  `ResultChunk`) once the whole fleet was confirmed on runner sidecars.
- `session/` — CRUD for sessions; resolves `externalId` so each subsequent
  turn carries it back to the sidecar for `--resume`. Also owns the
  session-default model choice: `POST /sessions` accepts
  `modelSelection`, `PATCH /sessions/:id/model` replaces/clears it
  (null = back to CLI default), both deliberately without deep
  validation — selections pass through to the CLI opaquely.
  Transcript loads page by TURN (`tailCommands` / `history?before=`),
  not by byte — a turn's chunk payload (tool meta, diffs, thinking
  text) dwarfs its count, which is why the API gzips responses
  (`compression()` in `main.ts`; nothing else fronts :4000 to do it)
  and the web opens with a 4-turn tail, paging 20 per scroll-up.
- `command/` — persists commands, `XADD`s to the machine × CLI runner
  stream (`machine:{id}:cli:{type}:cmd`), handles cancel. `dispatch`
  merges `Session.modelSelection` under per-turn `options` and records the
  merged map on `Command.options`.
- `machine/models.{service,controller}.ts` — `GET
  /machines/:id/models?cliType=`. Catalogs are keyed (machineId, cliType) —
  a property of the installed binary, not any session. Reads are DB-first:
  the sidecar pushes each CLI's catalog at runner spawn (unsolicited
  `model-catalog-response`, empty `requestId`) and it's persisted on the
  `MachineCliCatalog` row, so the endpoint is a Postgres read — warm
  across server restarts and for every browser. Stored catalogs older than
  6h are served as-is while a background revalidate runs
  (stale-while-revalidate; reads never block on freshness). The live RPC
  (same pending-promise pattern as `fs.service`) runs only for
  `?refresh=1` (the picker's manual refresh — the one synchronous path),
  the cold no-stored-catalog case, and the background revalidate; all of
  them re-persist. In-flight live fetches are collapsed per (machine, CLI).
- `attachment/` — file/image attachments. `POST /attachments` (JWT-
  guarded, multer `FileInterceptor`) streams an upload into S3/MinIO
  (`@aws-sdk/client-s3`, `forcePathStyle` for MinIO) and records an
  `Attachment` row (unlinked: `commandId` NULL until the turn is sent).
  `GET /attachments/:id?t=<token>` is **deliberately unguarded** —
  the sidecar has no user JWT and `<img>` can't send an Authorization
  header, so both authenticate with a short-lived JWT (`scope:
  attachment-download`, `sub:` the attachment id) minted by the same
  `JwtService`/`JWT_SECRET` and verified per-request; the bytes stream
  from S3. `CommandService.dispatch` links uploaded ids to the new
  command, mints **15-min pull tokens** for the wire `Command.attachments`,
  and returns/loads **1-h display tokens** in `AttachmentDTO.url`
  (`SessionService.withAttachments` batches them onto the transcript).
- `result-ingestor/` — single XREADGROUP across **all** runner result
  streams (refreshed every 5s): `machine:{id}:cli:{type}:result`, one per
  entry in each machine's `availableAdapters`. Persists each chunk and
  **immediately** forwards to WS room `session:{sessionId}` (no batching —
  the typewriter UX needs it).
  Also flips command/session status on `final`/`error` (success →
  session `idle` + `unread`, error → `failed` + `unread`; interim
  chunks → `active` + clears `unread`).
- `terminal/` — interactive PTY plumbing. Owns the `Terminal` row, exposes
  REST (`POST/GET /projects/:id/terminals`, `DELETE /terminals/:id`), a WS
  subgateway for `terminal:input` / `terminal:resize` / `terminal:close`,
  and a `TerminalLinkBridge` that routes inbound `SidecarLinkService`
  frames (output, closed) back to the browser WS and the DB. When the
  sidecar link drops, the bridge force-closes all of that sidecar's
  open terminals so the UI doesn't show zombies. Bytes are base64 over
  the wire to survive JSON. A small in-memory cache keyed by terminalId
  short-circuits Postgres ownership checks on every keystroke.
- `machine/background-task.{service,controller}.ts` — in-memory
  registry of every active + ended background task, populated by the
  service's own XREADGROUP loop on `streamKeys.background` (the
  dedicated `agent:background` stream; deliberately separate from
  `agent:lifecycle` because a fast tqdm bar emits 20+ events/sec and
  would otherwise trim heartbeats / sidecar-update progress out via
  MAXLEN — the same reasoning later moved the fs/git watcher nudges
  onto `agent:notify`). Keyed by `(machineId, workingDir,
  taskId)` — workingDir is the project identity, matching how notes
  scope. Each upsert fans out as `background-task:updated` on the
  per-project Socket.IO room (`project:<machineId>:<workingDir>`).
  Ended tasks **stay in memory forever** until a user explicitly
  dismisses them — `DELETE /machines/:id/background-tasks/:taskId?
  workingDir=...` removes from the map and broadcasts
  `background-task:removed`. Effect is global (every dashboard
  viewing the project sees the card disappear), matching how the
  earlier wall-clock auto-eviction worked. `GET /machines/:id/
  background-tasks?workingDir=...` hydrates a tab opening mid-run.
  No DB persistence — JSONL on the machine's disk is authoritative if
  you need history.
- `push/` — APNs sender for native clients. `DeviceController`
  (`POST /me/devices` upsert-by-token — re-homing a token that moved
  accounts — and idempotent `DELETE /me/devices/:token`) plus
  `PushService`: env-gated (all `APNS_*` unset = silent no-op),
  provider JWT (ES256 via jsonwebtoken, cached ~45 min), transport is
  raw `node:http2` because APNs requires HTTP/2 and Node's fetch can't
  speak it. Fired from `result-ingestor` at the exact point a session
  flips to `idle`/`failed` + unread (the same trigger as the web's
  desktop notifications); payload carries the session title, a
  `sessionId` for the client deep link, and — for completed turns — a
  ~300-char preview of the assistant's answer (deliberate trade-off:
  answer text on the lock screen in exchange for actionable banners;
  iOS "Show Previews: When Unlocked" is the user-side scope control;
  failures keep a fixed "Turn failed"). The preview uses the final
  chunk's content (claude-code's `result` carries the whole answer);
  codex finals are content-less, so `PushService.answerPreview`
  re-derives the answer via the deltaSplit boundary rule — making a
  THIRD port of deltaSplit (web `lib/deltaSplit.ts`, iOS
  `DeltaSplit.swift`, server `answerPreview`); change one, change all
  three. 410/`BadDeviceToken`/
  `Unregistered` feedback prunes the `DeviceToken` row.
  The phone banner is a **projection of the session's `unread` flag**:
  wherever `unread` flips false — `markSeen` (session opened on any
  client) or the ingestor's fresh-turn/cancel transitions —
  `clearSessionNotification` withdraws the banner via a silent
  background push (`content-available: 1`, priority 5) that wakes the
  iOS app to delete its own delivered notification (APNs has no
  server-side revoke). Gated by the in-memory `outstandingBanners` set,
  so the per-chunk caller costs a Set lookup and nothing is sent unless
  an alert actually went out.
- `sidecar-link/` — raw WebSocket server on path `/sidecar-link`
  attached to the same `http.Server` as NestJS (via `HttpAdapterHost`,
  `noServer` pattern). Owns one connection per sidecar, validates a
  shared-secret `SIDECAR_LINK_TOKEN`, and exposes `send(sidecarId,
  frame)` / `onFrame(...)` / `onDisconnect(...)` hooks to the terminal
  module. Pings every 15 s, idle-timeout after 45 s.
- `gateway/` — Socket.IO namespace `/stream`. Rooms: `user:{id}`,
  `session:{id}`, `terminal:{id}`, and the per-project
  `project:{machineId}:{workingDir}` (fs/git nudges + background tasks).
  Authenticates the handshake using the same JWT used for REST. The
  gateway is the **only** thing that emits live data to clients.
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
    bus URL, server link credentials, the project workdir allowlist) with
    an atomic write so the fs jail + watchers come up on restart *before*
    the server's `sync-projects` reconcile lands.
  - `discovery.go` walks the registered adapter set, runs `exec.LookPath`
    on each `DefaultBinary`, and probes `--version`. The result is
    reported in `MachineRegisterEvent.adapters` so the dashboard can
    filter the new-session adapter picker to what's actually installed.
  - `daemon.go` is the long-lived process: registers the machine,
    heartbeats, subscribes to `machine:{mid}:control` (`sync-projects` +
    fs/git/model RPC + sidecar-update), starts **one runner per installed
    CLI**, and holds the single sidecar↔server WebSocket on behalf of the
    whole host. It holds a *constant* number of Redis connections (control
    reader + one command reader per CLI type + publishes) regardless of
    how many sessions or projects exist — the property the runner refactor
    was built for.
  - `runner.go` owns one CLI type on this machine: it `XREADGROUP`s its
    `machine:{mid}:cli:{type}:cmd` stream, dispatches each turn to the
    adapter as an independent goroutine (`go handleCommand`, no per-session
    lock — sessions of the same type run truly in parallel), forwards
    chunks back on `machine:{mid}:cli:{type}:result`, and owns the `XACK`
    per command after the handler completes. There is no per-session or
    per-agent process.
  - `attachments.go` — `materializeAttachments` runs inside
    `handleCommand` **before** `adapter.Execute`: for each
    `cmd.Attachments` ref it HTTP-GETs `{serverURL}/attachments/{id}?
    t={token}` (serverURL threaded in from `cache.Server.URL`), writes
    the bytes under `<workingDir>/.argus/uploads/<id>-<name>` bounded by
    the ref's declared size, records the absolute `LocalPath`, and
    appends a uniform "attached files" path-listing preamble to the
    prompt. Fail-soft per file (a bad pull is logged and skipped, not
    fatal). `safeAttachmentFilename` jails the on-disk name (strips
    path separators / control chars; id-prefixed for collision safety).
    Workdir-less sessions fall back to a temp dir.
- `quota/` — per-CLI plan-quota prober. Runs on a 5-minute tick inside
  the daemon, reads each tool's OAuth file
  (`~/.claude/.credentials.json`, `~/.codex/auth.json`) and calls the
  same internal endpoints the CLIs' own `/status` commands hit
  (`api.anthropic.com/api/oauth/usage` for claude-code,
  `chatgpt.com/backend-api/wham/usage` for codex). Both endpoints are
  undocumented and reverse-engineered; failures degrade per-row so the
  panel can still render the rest of the fleet. Latest snapshot is
  cached in memory and piggy-backed onto the next `machine-heartbeat`
  event — no extra Redis stream. ChatGPT mode flips the response's
  `percent_left` semantics to a uniform "utilization-used" before
  publishing so the wire stays the same shape across vendors.
  - `fs.go` / `fswatch.go` / `git.go` — workingDir browsing for the
    dashboard's right-pane file tree. `ListDirs` BFS-walks up to
    `maxDepth` levels (reusing a single `listDirWith` core + one
    preloaded gitignore matcher) and returns a `path → entries` map
    so depth-N prefetch lands in one round trip. Both jail to the
    request's workingDir, always strip `.git` AND `.argus/`, and
    respect gitignore. `fsWatcher` registers one fsnotify watch per
    non-ignored dir and coalesces events into 250 ms-debounced
    fs-changed emits (published on `agent:notify`, not `lifecycle` —
    one event per dirty dir per window still bursts on big builds). `git.go` reads `.git/HEAD` (and resolves the
    worktree-pointer file form) without shelling out to `git` or
    pulling in a Go git lib — its output is attached to every
    fs-list response so the dashboard's branch badge refreshes for
    free on every tree refetch.
  - `progresswatch.go` — tertiary fsnotify watcher rooted at
    `<workingDir>/.argus/progress/`, picking up the JSONL stream
    `argus-bg` writes when wrapping a long-running command. Each
    decoded line becomes one of the three
    `BackgroundTask{Started,Progress,Ended}Event` frames, forwarded on
    the `agent:background` stream so the dashboard's per-project
    Progress tab can render live status for detached background work
    the CLI's PTY would otherwise never see (anything backgrounded
    with `&` / `nohup` flows only to log files, not to the PTY the
    sidecar captures). `bgEvent` is the wire format on disk; the
    watcher decorates it with machineId / workingDir before publishing
    (the events are scoped by `(machineId, workingDir, taskId)`).
    Soft-fails the same way fsw / gitw do — a missing or read-only
    progress dir just means the tab stays empty.
- `bus/` — go-redis wrapper with `Publish`, `EnsureGroup`, `ReadMessage`, `Ack`.
- `adapter/` — `Adapter` interface and process-level **registry**. Each
  adapter file calls `Register(type, &Plugin{Factory, DefaultBinary})`
  from `init()` so discovery can find the binary by name on `PATH`.
  Built-in adapters that report `--version` implement the optional
  `Versioned` interface (see `util.ReadBinaryVersion`); the daemon
  prefers the auto-detected string over anything baked in.
  - **Model selection** rides `Command.Options` as flat keys
    (`model` / `effort` / `context` / `speed`, constants in
    `protocol`); each `Execute` appends only the flags its CLI knows:
    claude-code `--model x[1m] --effort l`, codex `--model x -c
    model_reasoning_effort=l -c service_tier=fast`, cursor-cli
    `--model <slug>` (the slug already encodes everything).
  - **Model catalogs** come from the optional `ModelLister` capability
    (`models_claude.go` static alias table, `models_codex.go` parses
    `codex debug models` JSON, `models_cursor.go` parses
    `cursor-agent models` lines and labels family/variant groups).
    Two paths: the daemon fires `PushModelCatalog` after every
    runner spawn (unsolicited push, empty `requestId`, 30 s exec
    budget, errors logged-not-published so a boot hiccup can't clobber
    the server's stored copy), and `HandleListModels` answers the
    on-demand `list-models` RPC with a 12 s deadline so a wedged CLI
    surfaces as a catalog error, not a server-side timeout. Both run
    under `cliSlots` (4) — a dedicated subprocess gate, deliberately
    NOT `fsSlots`, so tree walks and CLI probes can't queue behind
    each other.
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
  `Settings` struct (shells, max-sessions). `terminal:open` carries the
  explicit `cwd` (the project's workingDir); the runner opens the PTY
  there. `buildShellEnv` augments the spawned shell's environment with
  two hooks the Progress extension depends on: prepends the sidecar's own
  bin directory to `PATH` (so `argus-bg` is reachable without an
  absolute path) and exports `ARGUS_PROGRESS_DIR` pointing at the
  project's `<workingDir>/.argus/progress/`, which is also where the
  per-workdir `progressWatcher` is listening.
- `cmd/argus-bg/` — sibling binary shipped alongside the sidecar.
  Wraps any command (`argus-bg --label "training" -- python train.py`),
  runs the child in its own PTY so tqdm keeps its interactive
  rendering on, tees raw output to argus-bg's own stdout (so the user
  still sees the bar) and optionally to `--tee <log-path>`, parses
  tqdm frames off the byte stream and writes a structured JSONL
  event stream (`start` / `progress` / `end`) into
  `$ARGUS_PROGRESS_DIR/<task-id>.jsonl`. Throttled to one progress
  event per 500 ms OR per integer-percent tick — whichever comes
  first — so the file stays bounded under a chatty tqdm bar. Exits
  with the child's exit code so shell pipelines behave.
  The tqdm parser lives in `tqdm.go` with a table-driven test
  (`tqdm_test.go`) covering vanilla, description-prefixed,
  ANSI-coloured, and HH:MM:SS-eta variants. Carries its own
  `main.Version` (baked by the same Makefile `-ldflags` as the
  sidecar) so `argus-bg version` makes companion drift observable.
- `updater/` — self-update: reads the GitHub Releases API for
  `argus-sidecar-v*` tags, picks the matching `OS-arch` asset,
  verifies it against `SHASUMS256.txt`, and atomically `os.Rename`s
  over the running binary. The download→verify→chmod→atomic-install
  step is factored into `installFromRelease`, parameterized by asset
  base name + destination, so it backs both `Update` (sidecar → the
  running executable) and `DownloadCompanion` (a sibling binary →
  alongside the executable; `CompanionPath` resolves the location).
  Drives `argus-sidecar update` (CLI), `argus-sidecar download-bg`
  (CLI), and remote `update-sidecar` commands from the dashboard
  (`machine/update.go`). On the remote path the daemon detects its
  restart mode (`self`, `supervisor`, `manual` — see the gotcha
  below) and either re-execs in place via `syscall.Exec`, exits 0
  for systemd/launchd, or stays put and asks the operator to
  restart manually.
- **argus-bg lockstep.** `Update` deliberately doesn't touch `argus-bg`;
  the caller decides when to refresh it. Both the CLI `update`
  (`cmd/sidecar/main.go`) and the remote `handleUpdateSidecar`
  (`machine/update.go`, via `refreshBG`) gate the refresh on
  `updater.CompanionUpToDate("argus-bg", tag)`, where `tag` is the release
  the sidecar just resolved to. That probe execs the installed
  `<bin-dir>/argus-bg version` (absolute path — never PATH-resolved) and
  compares its reported tag to `tag`; it refreshes via
  `DownloadCompanion("argus-bg")` from the *same* release on anything but
  an exact match. **It is fail-safe**: a missing file, exec error, wrong
  arch, an old `argus-bg` with no `version` subcommand, or an unparseable
  line all read as "not up to date" → reinstall — never skip. This is what
  closes the *present-but-stale* hole (e.g. a prior best-effort refresh
  that failed leaves `argus-bg` behind on an otherwise-current sidecar).
  `--force` bypasses the probe and always reinstalls. The whole step is
  best-effort: a checksum/permission failure on the companion is logged but
  never fails the sidecar update. The standalone `download-bg` subcommand
  fetches the companion unconditionally (no version gate) — it's the
  explicit repair path. Remote refreshes pin `updater.DefaultRepo` for the
  same hostile-server reason the remote sidecar update does.
  Trade-off worth knowing: gating on version means a same-version-but-
  corrupt `argus-bg` is *not* re-verified (the always-download path used to
  re-check its SHA every run); `--force` or `download-bg` is the escape
  hatch.
- `cmd/sidecar/main.go` — subcommand dispatch (`init`, `update`,
  `download-bg`, `version`, default = run daemon), flag parsing, signal
  handling, runner glue.

### `apps/web/src/`

- `lib/api.ts` — typed REST client.
- `lib/ws.ts` — single Socket.IO connection with reconnect; broadcasts events
  to a small set of subscribed handlers.
- `stores/` — Zustand slices: `authStore`, `machineStore`, `sessionStore`,
  `projectStore`, `uiStore` (no `agentStore` — it was deleted with the
  Agent entity). Sessions are stored by id with their full `chunks`
  buffer; the WS pushes new chunks via `appendChunk`, which guards
  duplicates by `id`.
- `components/StreamViewer.tsx` — the streaming display. Groups chunks by
  command, concatenates `delta`s, renders tool pills, stdout, errors, and a
  cursor while running. Final-answer markdown is rendered with
  `MarkdownCodeBlock` as the custom `<pre>` renderer; that component
  detects ```` ```html ```` fenced blocks and renders them through the
  shared `HtmlPreview` component, defaulting to the rendered view with
  a Source toggle. `HtmlPreview` has two sandbox postures keyed off its
  `autoHeight` prop. `FileViewer` (`.html` files) uses the strict
  `sandbox=""`: opaque origin, no scripts, sized by its container —
  remote-tree file content stays fully inert. The chat code-block path
  passes `autoHeight` and uses `sandbox="allow-scripts"`, so model-
  generated pages can run JS (Chart.js and other CDN-loaded libraries
  work). It deliberately does NOT add `allow-same-origin`: the frame is
  a unique opaque origin, so its scripts can't reach the dashboard's
  window, cookies, `localStorage`, or APIs. `allow-scripts` +
  `allow-same-origin` from our own origin is the one combination that
  escapes the sandbox into the user's session — we never grant it.
  Because an opaque origin blocks the parent from reading
  `contentDocument`, auto-height is no longer measured from outside:
  an injected bootstrap script postMessages its own `scrollHeight` and
  the parent (validating `event.source` identity — `event.origin` is
  `"null"`) grows the frame. Color-scheme injection follows the
  dashboard theme in both modes. Gotchas: (1) chat-path scripts can
  still reach the network — that's how CDN libs load, but it also means
  they could beacon out; accepted because the opaque frame holds no
  session or privileged data, and a no-network CSP is intentionally not
  injected since it would block those same libs. (2) While a final
  answer streams, `srcDoc` changes per token and the iframe reloads, so
  the bootstrap and any chart code re-run on each partial — noisy but
  isolated and harmless; it settles when the block completes.
- `components/TodoWindow.tsx` — per-turn task tracker rendered inside the
  sticky band right under `<ActivityPill>`. Sources its rows from the
  *latest* `TodoWrite`-style tool chunk in the command's chunks
  (`meta.tool ∈ {todowrite, todo, task, updatetodos}`, `meta.input.todos`);
  each call replaces the full list, no merging. Open by default,
  user-collapsible via the chevron — there is intentionally no auto-collapse
  when all todos complete (we want the finished plan to stay visible next
  to the assistant's answer). Returns null for codex sessions / any turn
  without a TodoWrite chunk. Shape parsing is deliberately defensive —
  cursor-agent ships todos with `TODO_STATUS_*` enum values and a
  `updateTodosToolCall` key; the sidecar mapper normalises both into
  Claude Code's lowercase form, and the component falls back to the same
  normalisation on the off chance an older sidecar is in front. Claude
  Code ≥ 2.1.x replaced `TodoWrite` with incremental `TaskCreate`/
  `TaskUpdate`/`TaskList` tools; the sidecar reconstructs the list and
  emits synthesized `TodoWrite` snapshot chunks, so this component needs
  no awareness of them (see the "Task tools" gotcha). See the AGENTS.md
  note on stream-json drift.
- `components/Sidebar.tsx` — flat project → session tree. Top level
  groups sessions by their pinned `(machineId, workingDir)` project —
  same path on different machines lives on different physical
  filesystems, so they get separate rows. Each project row shows a
  folder icon + label + small machine glyph; sessions with no
  `workingDir` fall into a per-machine `no project` bucket. **A project
  expands directly into its sessions** — there is no agent layer in the
  tree at all. Each `SessionRow` leads with the CLI type icon
  (`AgentTypeIcon` driven by `session.cliType`), so the user can tell a
  claude session from a codex one. **Creation hierarchy** mirrors the
  tree: the bottom `MachineList`'s hover `+` opens `CreateProjectPopover`
  (name + workingDir + terminal default — no adapter), which writes a
  placeholder into `useProjectStore`; the project row's hover `+` opens
  `CreateAgentPopover` (historical name — it only creates sessions now),
  which collects adapter + session name and POSTs the project-first
  `CreateSessionRequest` (`machineId` + `workingDir` + `cliType`). The
  server pins the session to a `Project` row (`projectId` + `cliType`)
  and returns it; the workingDir can never change afterwards (claude-code
  and cursor keep resume state on disk keyed by the cwd). Projects are
  derived by `groupProjects()` over the session list + the hydrated
  `Project` rows (`useProjectStore`), keyed by the
  `(machineId, workingDir)` pair — placeholders let an empty project
  render before its first session. Placeholders are server-backed (POST
  /projects, archive/rename endpoints; `argus.projects` localStorage is a
  paint-instantly cache hydrated from GET /projects, with a one-shot boot
  migration — `migrateLocalProjects.ts`). Archiving a project from its
  hover action cascades client-side: every non-archived session under it
  is archived via REST (skipping items already archived individually),
  then the placeholder's `archivedAt` is set together with a snapshot of
  the session IDs the cascade flipped (`archivedSessionIds`;
  `archivedAgentIds` is retained in the wire snapshot as `[]`). Restore
  consults the snapshot and only un-archives those IDs — so a session the
  user archived individually BEFORE the project archive stays archived
  after restore. `Promise.allSettled` on the archive path so per-item
  failures don't poison the snapshot; restore uses per-item `.catch` so a
  since-destroyed row 404s without blocking the rest. Legacy placeholders
  archived before the snapshot existed fall back to a broad restore.
  The `showArchivedAgents` toggle (historical name) reveals archived
  placeholders. Per-project show-archived state lives in
  `uiStore.showArchived` keyed by the project-group key. Expansion state
  lives in `uiStore.expanded` keyed by `proj:<machineId>::<workingDir>`
  (default open). The synthetic `no project` bucket hides the project-row
  `+` since it has no path to anchor a session against. Each project
  row's folder icon is itself a
  picker (`ProjectIcon`/`ProjectIconGlyph`) — clicking opens a
  6×5 letter grid plus a `reset to folder` action; the picked
  A-Z glyph persists to the server's `Project` row (PATCH
  /projects/icon via the `project/` module, workspace-shared like
  `Machine.iconKey`) and renders in place of the default Folder
  in both the main sidebar and the rail. The dashboard hydrates
  `useProjectStore.serverIcons` from `GET /projects` at boot
  (and on WS reconnect), keeps it warm via `project:upsert`
  events, and persists it with the store so glyphs render
  instantly on reload; the picker updates the map optimistically
  and rolls back on API failure. `LocalProject.iconKey` is the
  deprecated pre-sync location — `migrateLocalProjectIconsToServer`
  (one-shot, mirrors `migrateMachineIcons.ts`) pushes leftovers up
  on boot once machines + server icons have hydrated, then strips
  the local copies so a stale letter can't shadow a reset made
  from another browser. No auto-default from the project name —
  picking is what binds the letter to the project in the user's
  memory. Rename is the pencil action in the project row's hover
  stack and commits via `useProjectStore.add()` on the existing
  key (creates a placeholder for purely agent-derived rows).
- `lib/projects.ts` — shared `groupProjects()` derivation +
  `ProjectGroup` type consumed by both `Sidebar` and `SidebarRail`, plus
  `resolveProjectRef(session, projects)` which turns a session's
  `projectId` into the `(machineId, workingDir)` pair. Pure functions;
  callers pre-filter for whatever archived-visibility posture they want.
  `groupProjects()` takes the `machineStore.machines` map and sorts the
  rows via `sortProjectGroups()` — a verbatim port of the iOS client's
  `projectGroups(fleet:)` order: online machines first, then machine name
  (case-insensitive), then the per-machine `no project` bucket sinks,
  then project label (case-insensitive), then group key as tiebreaker.
  (The agent→runner refactor had flattened the tree to raw `projectStore`
  arrival order, dropping the machine/project grouping; iOS kept it, so it
  was ported back here.) `localOrder` now only selects *which* rows appear
  (and their archived-visibility filter); the machine→project sort owns
  display order. Sessions within a project stay newest-first — that sort
  lives in the callers, not here.
- `components/SidebarRail.tsx` — collapsed-mode rail (48px wide).
  Renders one tile per project using the same `groupProjects()`
  derivation as the main sidebar, with `ProjectIconGlyph` for the
  glyph. Click jumps to the project's most-recent non-archived
  session; hovering a tile for ~500ms opens a session flyout (portaled
  to `<body>` to escape the rail's `overflow-y-auto`, same trick as
  `CreateAgentPopover`) listing the project's non-archived sessions so
  any session is one click away without re-expanding the sidebar. A
  200ms close grace lets the pointer cross the tile→panel gap; the
  flyout header replaces the tile's old native `title` tooltip (they'd
  race each other on hover). Archived projects and the synthetic
  `no project` bucket are hidden — the rail is for active-state
  navigation, not history. Machine strip + logout at the bottom
  unchanged.
- `components/ContextPane.tsx` — right-pane companion to a session. Header
  shows the session's cliType + working dir + model + machine status. A
  collapsible `Details` block surfaces session + machine metadata
  (machine, status, working dir, session title, external id, updated,
  model). The bottom region is tabbed: **Commits** (`GitLogPanel`),
  **Files** (`FileTree`), **Terminal** (`<TerminalPane>`), and — only when
  the Notes extension is on (`uiStore.notesExtensionEnabled`) and the
  session has a `workingDir` — **Note** (`<NotePane>`), plus two more
  extension tabs gated the same way: **Progress** (`<ProgressPane>`,
  `progressExtensionEnabled`) and **Diff** (`<DiffPane>`,
  `diffExtensionEnabled`). ContextPane receives the session's `commands`
  (not just `chunks`) so the Diff tab can scope its file diffs to the last
  turn. Commits/Files render only when a `ProjectRef` resolves
  (lib/projects.ts — session.projectId → the (machineId, workingDir)
  pair): they fetch via the `/projects/:id/*` routes and join the project
  WS room; file tabs are scoped by projectId (`fileTabsStore.scope`), and
  the queue drainer's reachability check is machine-level, resolved
  through the same ProjectRef.
- **Open file tabs auto-refresh when a CLI edits the file** — see the
  "Live file tabs" gotcha for the mechanism and why the traffic is
  bounded. `lib/useFileTabAutoRefresh.ts` is mounted from `SessionPanel`
  (NOT `FileViewer`, which exists only for the focused tab).
- `components/MachinePanel.tsx` — `/machines/:id` route. Header with
  machine glyph + name + status dot + sidecar-update button. Below the
  header: Host KV + a `Supports` footer of installed adapters (from
  `availableAdapters`), then the machine's **projects** (grouped by
  workingDir — the same unit sessions pin to). Soft-delete lives in the
  header overflow.
- `pages/UserPanel.tsx` — `/user` route, settings-page layout. Sticky
  account band at the top (email + role); below it a left section nav
  (Stats / Preferences) and a scroll column with Activity (a `Grid` /
  `Curve` segmented toggle over one `/me/activity` payload — `Grid` is
  the GitHub-style `ActivityHeatmap`, `Curve` is `ActivityLineChart`, a
  by-day commands line; pure client-side view swap, defaults to Grid),
  Usage (token ledger with a rolling 7-day / 30-day / all-time
  segmented toggle — one `/me/usage` payload carries all three, the
  toggle is pure client-side slicing, defaults to 30 days), Quota
  (per-CLI plan windows pulled
  from each sidecar's heartbeat — see `packages/sidecar/internal/quota`
  and the `/me/quota` endpoint), Preferences (notifications, user
  rules editor), and Extensions (opt-in features: **Notes**, **Progress**,
  **Diff**). Each on/off flag is an account-level preference persisted
  server-side via `GET`/`PUT /me/extensions` (a JSON map on `User`, so
  new extensions need no migration — `coerceExtensions` defaults unknown
  keys to `false`); the matching `uiStore.*ExtensionEnabled` flag is a
  localStorage cache for synchronous, flash-free reads, reconciled
  against the server on bootstrap (`App.tsx`). Each toggle PUTs the full
  flag set (no server-side merge), so all toggles forward every flag.
  Capped at `max-w-6xl`.
- `components/TerminalPane.tsx` — xterm.js bound to one project (machine +
  cwd). Owns the WebSocket plumbing, a debounced ResizeObserver for fit,
  base64 encoding on input, and a duplicate-seq guard on output. Renders
  inside the **Terminal** tab of `ContextPane` so we don't pay the xterm
  cost until the user clicks the tab.
- `components/NotePane.tsx` — free-form per-project scratchpad in the
  **Note** tab of `ContextPane`. The note is keyed by the
  `(userId, machineId, workingDir)` triple in the
  `ProjectNote` table and reached via `GET`/`PUT /me/project-notes`
  (machineId + workingDir as query params). Two sessions in the same
  working dir edit the same note. Debounced autosave (~700 ms) rather
  than a Save button; byte-capped at `PROJECT_NOTES_MAX_BYTES`. Both the
  extension on/off flag and the note *content* are server-persisted per
  user (see `/me/extensions` and `/me/project-notes`), so they survive
  browser switches. Unlike `User.rules`, notes are personal scratch and
  are never fanned out to sidecars.
- `components/DiffPane.tsx` — the **Diff** tab. Pure client-side
  aggregation: it scans the loaded `chunks` for the session's most recent
  Execute command and collects every result chunk with `meta.isDiff`,
  grouping by `meta.filePath` with summed `+/-` counts and the file path
  shown relative to `workingDir`. No new capture — it reuses the unified
  diffs the sidecar already emits per edit (see **File-edit diffs**) and
  the shared `components/ui/DiffBlock.tsx` renderer. Re-derives reactively,
  so diffs stream in live while a turn is still editing. Each file's
  header row is a collapse toggle (chevron), and its diff body is wrapped
  in a `max-h-80` `overflow-y-auto` box so one huge patch can't push the
  other files off-screen — the wrapper owns the cap + visible scrollbar,
  the inner `DiffBlock`s stay uncapped (`maxHeightClass=""`). Collapse
  state is local component state keyed by the file's stable absolute path
  (`collapsed[rawPath]`), so it survives the live re-derivation; files
  default to expanded. State resets when the Diff tab unmounts.
- `components/Composer.tsx` + `components/PromptQueue.tsx` +
  `stores/queueStore.ts` + `lib/queueDrainer.ts` — the **prompt queue**.
  While a turn is running the Composer's submit no longer no-ops: it parks
  the prompt (text + already-uploaded attachment ids/name/mime, *not* the
  object-URL thumbnail — those don't survive a reload) into a per-session
  FIFO in `queueStore` (persisted under `argus.queue`), rendered as the
  small editable/removable list `PromptQueue` shows directly above the
  input. **Draining is app-wide**, not per-panel: `useQueueDrainer()` is
  mounted once in `App.tsx` and sends queued follow-ups for ANY session as
  it frees up, regardless of which session (if any) is open. A manual
  submit while a backlog is still draining also queues (joins the back)
  rather than jumping the FIFO.
  - **Pacing clock = `session.status`, not the machine heartbeat.** Machine
    online is heartbeat-reported every 5s (too laggy for turn-to-turn
    pacing); `session.status` ('active' while streaming → 'idle'/'failed'
    when done) is event-driven AND broadcast to the whole `user:{id}` room,
    so `sessionStore.sessions[id].status` stays fresh for every session,
    open or not. The drainer subscribes to the queue/session/machine stores
    (debounced ~120ms to coalesce chunk-append bursts) and re-evaluates.
  - **Serialization is per SESSION.** Each turn spawns its own short-lived
    CLI process (`claude --resume <session-external-id>`) and the runner
    dispatches them as independent goroutines with no per-CLI lock
    (`runner.go` `go handleCommand`, no `cliSlots` gate on `Execute`) — so
    sessions of the same type on one machine run truly in parallel. The
    drainer therefore gates a session only on its OWN state: skip while
    `session.status === 'active'`, or while an `inFlight` guard is set (it
    bridges the dispatch→first-chunk window where the new turn isn't
    `active` yet; clears once it goes active or after a 30s timeout). The
    one invariant it protects: never two turns for the SAME session at once
    (they'd both resume the same id off the pre-turn transcript and corrupt
    it). Reachability is machine-level: skip when the session's machine is
    `offline`.
  - On a loaded (open) session the drainer also optimistically
    `upsertCommand`s the returned row for instant feedback. A failed
    `sendCommand` restores the head (`enqueueFront`) and stalls it with a
    60s cooldown so a hard error can't hot-loop while transient ones still
    self-heal. Known gap: cross-tab isn't coordinated (each tab's persisted
    queue is independent), so the same session queued in two tabs could
    double-send.

### `apps/ios/` (native client — WIP)

- `ArgusKit/` — SwiftPM package holding everything except UI: Codable
  DTO mirrors of shared-types, `ArgusClient` (REST), `StreamClient`
  (Socket.IO `/stream` → `AsyncStream`), and a pure transcript engine
  (`TranscriptState` + ports of `deltaSplit` / `parseUsage` /
  `contextWindow`). The SwiftUI app target arrives in Phase 1
  (XcodeGen-generated, never committed). See `apps/ios/README.md`.
- **No codegen, by decision.** An earlier OpenAPI-pipeline attempt
  (`feat/ios-native-client`, deprecated) fought swift-openapi-generator
  constantly. Instead the Swift models are hand-written and
  decode-tolerant (unknown fields ignored, open enums fall back to
  `.unknown`), and contract confidence comes from
  `scripts/capture-ios-fixtures.sh`: it captures sanitized live-server
  responses into the package's test fixtures, which CI decodes.
- **Runner-refactor posture** (docs/plan-agent-to-runners.md, complete):
  the Agent entity is retired, so there is no `agentId`, `AgentDTO`, or
  fleet-agents store on the client. Sessions carry their own
  `projectId`/`cliType`; `FleetStore.projectRef` resolves the
  `(machineId, workingDir)` pair; session creation is project-first;
  fs/git/note/progress/terminal panes are all project-addressed; the model
  picker is keyed (machineId, cliType); and queue reachability is
  machine-level. `ToleranceTests` still pins that a stray `agentId` from an
  older server decodes as an ignored extra field (never a decode failure) —
  keep that tolerance; never add strict decoding.
- **Swift is CI-compiled.** The dev box is Linux (no toolchain), so
  `.github/workflows/ios.yml` — `swift build`+`swift test` for ArgusKit
  and an `xcodebuild` Simulator build for the app — IS the compiler for
  Swift changes. It runs on push to main/dev/`feat/ios-*`, on PRs, and
  via `workflow_dispatch` for refactor branches.
  **If you change a shared-types DTO, update the Swift mirror and
  re-capture the fixtures in the same PR.**
- Swift is authored on Linux but only compiles on macOS —
  `.github/workflows/ios.yml` (macOS runner, `swift build` + `swift
  test`) is the primary verifier, not the dev box.
- Wire gotcha the fixtures encode: REST-served chunks drop
  `sessionId`/`isFinal` and serialize `ts` as an ISO string, while the WS
  `chunk` event relays the full wire shape with numeric millis; command
  rows carry a denormalized `usage` field shared-types omits.
  `ResultChunk`'s custom decoder + Codable's ignore-unknown default absorb
  all of this — don't add strict decoding.
- Same family: the finalize/cancel `command:updated` events carry a
  CommandDTO **without `attachments`** (bare `CommandService.toDto`).
  Any client that replaces its command row on that event wipes the
  turn's thumbnails — both stores merge instead (web
  `sessionStore.upsertCommand`, iOS `TranscriptState.upsert`), keeping
  existing attachments when an update arrives without them.
- **Session view-model cache (stale-while-revalidate).** `AppModel`
  keeps `SessionViewModel`s alive across session switches (LRU, cap 8,
  never evicts the on-screen one, cleared on logout), so re-opening a
  recent session renders its transcript instantly instead of spinner +
  full tail refetch. A cached transcript is always suspect — off-screen
  sessions leave their WS room — so `SessionViewModel.start()` is
  idempotent: cold VMs full-load, loaded VMs *revalidate*: refetch the
  tail and MERGE it when the fresh window overlaps the cached commands
  (ids stay stable, scrolled-in older pages survive); a disjoint window
  (> 20 turns landed while away) falls back to wipe-and-replace, since
  merging it would leave a hole mid-transcript. App-foreground reuses
  the same path (`activeSession?.start()`), so foregrounding no longer
  blanks the transcript and resets scroll. Gotcha: `agentType` is
  frozen at VM init and keys the usage parsers, so the cache factory
  replaces a VM cached with the `"custom"` fallback once the real agent
  type is known (and conversely keeps a cached real type when the
  caller only knows `"custom"`).
- **Sidebar archive toggles — two look-alike keys, keep them distinct.**
  `SessionSidebar` mirrors the web's two independent archive controls,
  and their persistence keys are confusingly close: `argus.showArchived`
  is the wire-name misnomer (`showArchivedKey`) holding the SET of project
  keys whose archived *sessions* are revealed (the per-project eye,
  `uiStore.showArchived`); `argus.showArchivedProjectsGlobal`
  (`showArchivedProjectsKey`) is the single global boolean that hides
  archived *projects* (`uiStore.showArchivedProjects`). Archived-ness of a
  project rides on `ProjectGroup.archived` (from `ProjectDTO.archivedAt`);
  the orphan bucket is always `archived: false`. Because iOS groups are
  derived from sessions (no empty-project placeholders like the web), the
  hide toggle's count is over renderable archived *groups*, not project
  rows — an archived project with no sessions has no group and isn't
  counted, which is fine since it wouldn't render either way.

## Conventions

- **Path alias**: `@argus/shared-types` resolves to the package's source
  (Vite + tsconfig paths). Don't import from compiled `dist/` directly.
- **Status vocab**: machines use `online | offline`; sessions use
  `active | idle | failed`; commands use the lifecycle in the Prisma
  schema (`pending|sent|running|completed|failed|cancelled`).
- **IDs**: sessions and commands use `cuid()`. Machine ids are minted
  once by `argus-sidecar init` and persisted to the cache (regenerated
  only with `init --force`), stable across restarts. Projects are keyed
  by the `(machineId, workingDir)` pair.
- **At-least-once delivery**: chunks may be redelivered after a server
  restart. The store de-dups by chunk `id`; the DB write swallows unique-key
  collisions.
- **WS rooms**: clients join `session:{id}` to receive that session's chunks
  and `command:*`/`session:*` updates, and `project:{machineId}:{workingDir}`
  for fs/git nudges + background tasks. `machine:*` is emitted to everyone;
  per-user events go to `user:{id}` only.
- **Streaming over batching**: never coalesce `delta` chunks server-side.
  Drop only when a *specific* socket is lagging (TODO — see follow-ups).

## Gotchas

- **Model detection is LATEST-match, in both clients**: the right-panel
  model line and the context ring's window lookup derive the model from
  chunk `meta` (`parseModel`). Web `useSessionModel` scans backward;
  iOS `TranscriptState.latestModel()` likewise. It used to be
  first-match on web (pre-model-picker assumption "set once at session
  init"), which pinned the label and ring denominator to the oldest
  loaded turn even after a mid-session model swap — and shifted it
  *backward* when scrolling paged older history in. Keep both clients
  on latest-match.

- **A turn may deliver MORE THAN ONE terminal chunk — finalize must be
  idempotent**: sidecars ≤ 0.2.7-rc.1 emitted two finals per healthy
  turn — the CLI's own `result` final (rich: usage, real
  success/failure) and, when the process exited, `clistream.go`'s
  unconditional synthetic final (a safety net meant for CLIs that die
  without a result event). The web absorbed the duplicate (it notifies
  on the active→terminal *transition* and `tag`-collapses browser
  notifications), so it stayed invisible until APNs push fired once per
  terminal chunk → two lock-screen alerts per turn. Fixed twice over:
  the sidecar now suppresses the synthetic final when the mapper
  already emitted a terminal chunk, and the ingestor finalizes
  first-final-wins (status-guarded `updateMany`; the rich final always
  precedes the synthetic one). Keep both: Redis delivery is
  at-least-once, so the server can see a duplicate final regardless of
  sidecar version. Related subtlety: the trailing final of a CANCELLED
  turn is what flips the session back to `idle` (CommandService.cancel
  only marks the Command row) — the ingestor's already-terminal branch
  handles that case explicitly, without a push or unread dot, and no
  longer overwrites `cancelled` with `completed`.
- **Live Activity throttles must trailing-edge flush**: both lock-screen
  card update paths throttle tool-count updates — `LiveActivityManager`
  at 2s locally, `PushService` at 15s via APNs. The 15s floor is
  deliberate: priority-10 `liveactivity` pushes draw from an
  undocumented per-app hourly budget, and sustained sub-15s cadence
  gets *silently* throttled on-device (APNs still returns 200) unless
  the app opts into `NSSupportsLiveActivitiesFrequentUpdates`. The
  original leading-edge-only throttles (`if now - last < window
  return`) discarded every update inside the window, so the card sat
  stale on the leading state through a burst and snapped 1→4→10 tools
  when the next chunk happened to land outside a window. Both sides now
  arm one timer per window that pushes the then-current counters at
  expiry — same push rate (≤ 1/window, no extra APNs budget), bounded
  staleness. `end`/`endLiveActivity` must disarm that timer, or the
  trailing "running" update fires after the ✓/✗ and revives a settled
  card. Tool counts still legitimately step by >1: one assistant
  message can carry several parallel `tool_use` blocks and the sidecar
  emits their chunks together.
- **Delivered APNs banners can only be withdrawn by the app itself**:
  there is no server-side revoke, so "read on web → banner gone on
  phone" works via a silent background push (`content-available: 1`,
  and `apns-priority: 5` — Apple rejects background pushes at 10) that
  wakes the iOS app to `removeDeliveredNotifications`, matched on the
  payload's `sessionId`. Background pushes are best-effort: Apple
  throttles them to an undocumented budget, defers them in Low Power
  Mode, and NEVER delivers them to a force-quit app — so the client
  also sweeps stale banners in `refreshAll` (cold launch, foreground,
  reconnect) against fresh `unread` flags. The server-side
  `outstandingBanners` gate is per-process memory: a restart forgets
  it, which the same sweep covers. Requires `UIBackgroundModes:
  remote-notification` in `project.yml` (regenerate with `xcodegen
  generate` — the Info.plist is generated).
- **`/compact` is real on claude-code only**: claude's `-p` mode parses
  it client-side — the stream is `system/status` (compacting →
  compact_result), `system/compact_boundary` (pre/post token counts in
  `compact_metadata`), an injected summary user-message, and an empty
  zero-usage result. The adapter maps these to progress chunks
  (`contentType: compact_boundary / compact_summary / status`), the
  clients render a divider + collapsed summary, and the context ring
  snaps to `postTokens` (the compact turn's own usage is empty).
  codex `exec` and cursor-agent `-p` instead hand slash text to the
  MODEL, which role-plays a convincing fake "Compacted." reply while
  the context keeps growing (verified against both binaries,
  2026-07-18) — never surface a compact affordance for those adapters.
  Gotcha: the summary's wire shape differs by trigger (claude 2.1.210,
  confirmed by bundle disassembly). Manual `/compact` goes through the
  local-command handler and emits the summary as plain-STRING user
  content; AUTO compaction routes it through the engine normalizer,
  which rewraps it as a `[{type:"text",...}]` ARRAY. The adapter must
  accept both after a boundary (`textBlocksOnly` in claude_code.go) —
  matching only the string shape silently drops every auto summary.
- **`contextWindow.ts` has a hand-written Swift mirror, and the lockstep
  is hash-enforced**: the iOS context ring's table
  (`ArgusKit/Engine/ContextWindow.swift`) mirrors
  `packages/shared-types/src/contextWindow.ts`.
  `ContextWindowLockstepTests` pins the TS file's SHA-256 and
  `ios.yml` triggers on that path, so editing the TS table without
  porting the change (and re-pinning) fails iOS CI in the same push.
  This exists because the Fable 1M entry (53c9549) landed TS-side only
  and the iOS ring read 5x too full until a user noticed. Comment-only
  TS edits also trip the pin on purpose — the comments encode
  load-bearing rules (entry ordering).
- **`path:line` citations in markdown links**: CLI agents emit links like
  `[src/foo.go:123](src/foo.go:123)`. TWO layers conspire against these,
  and both must be handled (`StreamViewer.tsx`):
  1. react-markdown sanitizes hrefs *before* any custom `a` renderer
     runs — `defaultUrlTransform` keeps only http(s)/mailto/relative
     URLs, and `xxx.txt:1` parses as unknown scheme `xxx.txt:`, so the
     renderer receives `href=""` (and an empty-href anchor is a live
     link that reloads the current page — symptom: "clicking the link
     opened a new session"). `fileLinkUrlTransform` (passed via the
     `urlTransform` prop) rescues exactly the hrefs `splitLineSuffix`
     (`FileChips.tsx`) recognizes as `path:line`.
  2. The `a` renderer's own URL-scheme test would *also* misroute
     `xxx.txt:1` as an external anchor, so it strips the line suffix
     before testing and re-tests the bare path (keeps
     `http://localhost:3000` a real URL).
  Known miss: a dot-less, slash-less name like `Makefile:12` is
  indistinguishable from a URI scheme and renders as inert text. The
  line number rides on the file-tab entry (`fileTabsStore.ts`, not part
  of the tab key) and the viewer scrolls/highlights via shiki's
  per-line `.line` spans + the `.line-target` rule in `index.css`.
- **Prisma + workspace import**: the server can only typecheck if `rootDir`
  is unset, because `@argus/shared-types` lives outside `apps/server/src`.
  `nest build` is fine because it only compiles `src/`.
- **Prisma migration NAMES are replay ORDER**: migrations replay in
  lexicographic directory-name order, and this repo's numeric prefixes
  (`0_init` … `16_api_keys`) make that order non-obvious (`10_` sorts
  before `2_`). A default timestamp-named migration sorts mid-history —
  `20260706054229_add_device_tokens` landed with a folded-in drift fix
  referencing a table created by `3_…` and broke every FRESH-database
  replay (existing DBs were fine; they applied in creation order). Fixed
  by making the stray statement `IF EXISTS` and re-homing the real fix
  as `5a_…` (sorts after its dependency; idempotent for DBs that already
  ran the original). When adding migrations: keep statements independent
  of later-sorting migrations, or name them to sort after their
  dependencies; verify with `prisma migrate diff --from-migrations
  --to-schema-datamodel` (must be "No difference detected").
- **Adapter `init()`**: an adapter only registers itself if its file is
  *imported*. The blank `_ "..."` trick isn't needed today because they're
  all under the same package, but keep it in mind when adding adapters in a
  separate package.
- **Two Redis connections**: do **not** call `XREADGROUP` on the shared
  `cmd` ioredis client — it parks the socket and starves every other call.
- **Command consumption is per-CLI-runner, bounded per machine**: each
  runner `XREADGROUP`s its own `machine:{mid}:cli:{type}:cmd` stream, so a
  machine holds a *constant* number of blocking Redis connections (one per
  installed CLI + the control reader), not one per session or project —
  the whole point of the runner refactor, which killed the old per-agent
  reader that blew up connection count under N machines × N projects × N
  CLIs on a small Redis. The runner dispatches each decoded turn as an
  independent goroutine and owns the `XACK` after the handler completes;
  a `NOGROUP` after a Redis flush self-heals (re-ensure group + retry).
- **The sidecar's shared go-redis pool must stay explicitly capped**
  (`bus.Dial`): go-redis v9 defaults assume a dedicated Redis —
  PoolSize = 10×GOMAXPROCS, and idle conns are **never closed
  client-side**: v9 has no background reaper (v8's `IdleCheckFrequency`
  was removed), `ConnMaxIdleTime` is only enforced lazily when a conn is
  popped at checkout, the default LIFO pool keeps re-using the hot
  top-of-stack so post-burst conns at the bottom are never popped, and
  `Put()` re-pools unconditionally when `MaxIdleConns=0`. Sidecar
  publishes are fire-and-forget XADDs from many concurrent goroutines
  (runner result chunks, fs/git responders, watchers, heartbeat) at
  ~150ms RTT, so one busy streaming turn can open 15+ sockets in a burst
  that then linger until the server/NAT side kills them (~10 min) —
  observed 2026-07-16 pinning the 30-client Redis Cloud cap and refusing
  new clients (which also crash-loops a restarting server, see the
  Redis-unreachable boot gotcha). `bus.Dial` therefore pins
  `PoolSize`/`MaxActiveConns` = 8, `MaxIdleConns` = 3,
  `ConnMaxIdleTime` = 5m, `PoolFIFO` = true. Fleet budget on the 30-cap
  plan: server holds 4 (ioredis), each machine ≤8 at burst / ~5 steady →
  roughly 5 machines. Data-safe emergency relief when saturated:
  `CLIENT KILL` go-redis conns with `idle>300` and `cmd≠xreadgroup`
  (parked stream readers always show `idle≤5`; go-redis re-dials
  transparently, and Postgres is the source of truth).
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
  with a handful of machines: `lifecycle`=500, `agent:notify`=2000,
  `agent:background`=5000, `machine:{id}:cli:{type}:cmd`=200,
  `machine:{id}:cli:{type}:result`=500, `machine:{id}:control`=200. If
  you scale past that — more machines, chunkier terminal output, longer
  expected consumer outages — bump the relevant entry in *both* helpers
  and re-budget against your Redis `maxmemory`. Related trap when deciding
  which stream an event belongs on: `MAXLEN ~` only trims on `XADD`,
  so a *quiet* stream retains whatever it holds indefinitely. That's
  why the few-but-fat fs-list / fs-read / git-log responses stay on
  busy `lifecycle` (heartbeat churn evicts them within seconds) while
  only the tiny-but-bursty fs-changed / git-changed nudges moved to
  `agent:notify` — parking fat payloads on a quiet stream would hold
  those bytes hostage until enough later entries evict them. The `~` operator means
  Redis trims lazily on listpack boundaries, so actual stored length
  can briefly exceed N; that's the budget headroom, not slack to
  rely on.
- **Lifecycle consumer throughput must out-pace heartbeat inflow —
  per-entry awaits are the enemy**: every awaited round trip inside the
  consume loop divides throughput. Observed live (Jul 2026, ~144 ms RTT
  to a remote Redis, before the runner refactor cut heartbeat volume):
  one awaited `XACK` + one Prisma `update` per entry capped the consumer
  at ~2 entries/s against ~2.4/s inflow — the backlog grew until MAXLEN
  trimmed *undelivered* entries (group lag > stream length), so the
  fs/git/model RPC responses riding `lifecycle` vanished and the
  dashboard showed "the machine may be offline" for perfectly healthy
  sidecars, while `sweepStale` flapped live machines offline.
  `MachineService.processBatch` therefore (1) acks each batch with one
  variadic XACK, (2) handles no-DB events (`FAST_KINDS`: RPC responses,
  watcher nudges) before DB-bound ones so a response never waits behind
  heartbeats, and (3) coalesces machine-heartbeats newest-per-machine
  into grouped `updateMany` writes (keeping the newest *quota-carrying*
  heartbeat separately, since quotas ride only some heartbeats). The
  structural fix landed with the runner refactor: only machine-heartbeats
  hit this stream now (one per machine per 5s — no per-agent multiplier),
  so inflow is bounded by machine count. Don't add per-entry awaits back.
- **A multi-stream XREADGROUP fails as a unit on NOGROUP**: the
  lifecycle loop reads `agent:lifecycle` + `agent:notify` in one call;
  if the group is missing on *either* stream, Redis rejects the whole
  command and nothing is read from the healthy stream either. `DEL` of
  a stream (e.g. the emergency Redis-full runbook) deletes its groups,
  and a later XADD recreates the stream *without* them — so the
  NOGROUP self-heal in `consumeLoop` must re-ensure the group on BOTH
  streams (it healed only `lifecycle` until Jul 2026, which would have
  wedged all lifecycle consumption forever after a notify DEL). The
  result-ingestor's NOGROUP branch handles the same trap for destroyed
  agents' result streams.
- **MAXLEN caps entry COUNT, not bytes — one fat chunk can blow the
  whole budget**: the `streamMaxLen` caps above bound the *number* of
  entries, so the memory model silently assumes each entry is small
  (deltas, short tool output). It isn't always: a chunk that echoes a
  large tool result — e.g. an MCP tool like Penpot's `generateMarkup`
  returning ~1 MB of SVG per call, relayed whole as a
  `progress`/`content=mcp_tool_call` chunk — can sit at ~1 MB/entry. At
  500 entries that's a *half-gigabyte* budget on one
  `machine:{id}:cli:{type}:result` stream, well within the count cap.
  This is exactly what OOM'd the
  30 MB prod Redis once (one Penpot session → a 10 MB result stream →
  eviction → all sidecars dropped). Redis has **no byte-based MAXLEN**,
  so the only real fix is at the producer: cap oversized `content`/`meta`
  before `XADD`. **Deferred by decision** — a producer-side byte-cap
  (truncate a chunk's payload past ~128 KB with a marker) is lossy for
  the *display copy* of huge tool blobs (the answer `delta`s are never
  touched, and the CLI keeps the full result in its own model context,
  so it's a transcript-fidelity tradeoff, not a correctness one). Revisit
  if MCP/tool-heavy sessions keep pressuring Redis. Emergency reclaim
  while it's unfixed: `XTRIM <big>:result MAXLEN <small>` (safe — the read
  path is Postgres, not Redis).
- **Runner streams are per machine × CLI, not per session — no
  per-entity churn**: `machine:{id}:cli:{type}:{cmd,result}` streams are
  keyed by the machine and the installed CLI, both long-lived, so nothing
  creates or destroys a stream per session/project (the old per-agent
  `agent:{id}:*` streams that had to be `DEL`-reclaimed on destroy are
  gone with the Agent entity). The result-ingestor still self-heals a
  transient `NOGROUP` (e.g. after an emergency `DEL` in the Redis-full
  runbook) via its `NOGROUP` branch → immediate `refreshStreams`.
- **Lifecycle PEL is reclaimed on boot, not leaked across restarts**:
  the `server-lifecycle` consumer reads with `'>'` under a fixed name
  (`server-1`), so entries delivered-but-unacked when the server
  crashes/OOMs are never redelivered and pile up in the PEL forever (seen
  live: 3,200+ phantom pending after an OOM, unreclaimable once MAXLEN
  trimmed the underlying entries). `MachineService.reclaimStalePending`
  runs before the consume loop starts, draining this consumer's own
  pending list (`XREADGROUP … 0` → `XACK`) — it drops them rather than
  replaying (replaying stale heartbeats would flap dead machines online;
  the sidecar re-sends every 5s anyway). The steady-state loop already
  acks every entry, so the leak was purely the restart path. The group
  spans both `agent:lifecycle` and `agent:notify`, so the reclaim
  drains both streams' PELs.
- **`agent:notify` rollout order is server-first**: the server keeps
  accepting `fs-changed` / `git-changed` on `lifecycle` (shared handler
  switch), so old sidecars work against a new server indefinitely. The
  reverse skew degrades: a new sidecar publishing nudges to
  `agent:notify` against an old server finds no consumer group there,
  so nudges are silently dropped (file tree / commit panel fall back to
  manual refresh) and the orphan stream idles at its 2000-entry cap
  (~300 KB) until the server upgrade creates the group. Nothing
  breaks, but deploy the server before triggering sidecar updates.
- **stream-json drift**: each CLI's NDJSON event shape changes between
  versions. The mappers (`mapClaudeLine`, `mapCodexLine`) are
  defensive — unknown events fall through as `progress` chunks rather than
  crashing. For `system` events, the unknown-subtype fallback is
  **deliberately visible** (Content `"system"` → italic row in the
  activity timeline): that junk row is the observability breadcrumb that
  tells us a new subtype appeared and needs explicit handling. Don't
  "fix" it by making the fallback content-less — special-case known-noisy
  subtypes individually instead (as done for `thinking_tokens`,
  `task_notification`, `api_retry`, `vcs_state_changed`, and
  `code_change_published`).
  *Worked example of the breadcrumb doing its job:* a burst of "system"
  rows in a release session on `claude` 2.1.217 turned out to be two
  subtypes added since 2.1.210 (`vcs_state_changed`,
  `code_change_published`), both below. Method, if it happens again: the
  session transcript (`~/.claude/projects/<slug>/<id>.jsonl`) does **not**
  record `system` events — they're synthesized at the output layer — so
  diff `strings` of the two `~/.local/share/claude/versions/<v>` binaries
  for `type:"system",subtype:"…"` instead. In `-p` mode the CLI drains its
  event queue to stdout **unfiltered** (the interactive REPL bridge
  applies an allowlist), so the sidecar sees strictly more subtypes than
  the interactive UI does.
- **`api_retry` (Claude Code)**: `{"type":"system","subtype":"api_retry",
  "error_status":502,"attempt":N,"max_retries":10,"retry_delay_ms":…}`
  fires when an API call fails retryably and the CLI is backing off; it
  can fire several times per turn during API incidents. Mapped to a
  **content-less** `progress` chunk (full event in `meta`) so it doesn't
  render as a junk "system" row. No UI affordance yet — a future
  improvement could read `meta` to show "retrying N/10" while the turn
  stalls in backoff.
- **`vcs_state_changed` (Claude Code ≥ 2.1.217)**:
  `{"type":"system","subtype":"vcs_state_changed","kind":"commit"|"push"|
  "merge"|"rebase","cwd":"…"}` — the CLI classifies git/gh operations it
  observes in **its own Bash tool output** and emits one event per kind,
  so a single compound command fires several (`git checkout dev && git
  merge --ff-only main && git push origin dev` → `merge` + `push`).
  Payload-free by design: it says the repo changed, not what it changed
  to. Mapped to a content-less `progress` chunk with
  `meta.contentType="vcs_state_changed"` + `kind`/`cwd`, and **nothing
  else** — it is silenced, not consumed.
  **Design decision, considered and rejected (2026-07-24):** wiring this
  to a `git-changed` nudge so the dashboard reacts to `git push` (which
  `gitWatcher` structurally cannot see — a push moves
  `refs/remotes/<remote>/…`, and the watcher only watches `.git/HEAD` +
  `.git/refs/heads/`). Rejected on three counts, and the reasoning is
  worth keeping because the idea is tempting:
  1. **Refs on disk are the source of truth; this event is a claim.**
     It's the CLI's classification of its own shell output, not an
     observation of the repository. `gitWatcher` stays the single
     producer of `git-changed`.
  2. **It's attributed to the wrong directory.** `cwd` is the *session's*
     dir, not the mutated repo's — a turn running `git -C ../other push`
     emits `kind:"push"` with the session's cwd, nudging a repo that
     didn't change. A false positive the watcher cannot have.
  3. **The overlap is total where it matters, and the gap is empty.**
     Every kind the dashboard renders (commit / merge / rebase) already
     moves a ref `gitWatcher` sees. The one kind it uniquely catches —
     `push` — changes nothing the git panel displays: `git.go` puts
     ahead/behind explicitly out of scope, and `GitLogPanel` renders
     branch + short SHA + commit list, none of which a push alters.
  If ahead/behind ever lands in `GitStatus` (cheap now — `ReadGitLog`
  already shells out, so it's one `git rev-list --left-right --count
  @{u}...HEAD`), revisit (1) and (2) *first*: the honest fix is probably
  for `gitWatcher` to also watch `refs/remotes/`, not to trust the CLI's
  self-report. Remaining wire gotchas either way: `kind` is an **open
  set** (treat unknown values as "something changed"), and detection is
  best-effort — dry runs excluded, and a backgrounded command whose
  confirming output hadn't printed emits nothing.
- **`code_change_published` (Claude Code ≥ 2.1.217)**:
  `{"type":"system","subtype":"code_change_published","provider":"github",
  "url":"…/pull/36","repo":"owner/name","identifier":"36"}` — fires when
  the harness binds the session to a pull/merge request, on creation
  **and** on every later contribution (`gh pr edit/close/ready`, `gh pr
  checkout`, or a plain push to a branch with an open PR). It repeats for
  the same URL many times per session (11× in the session that surfaced
  it), so it is idempotent rebinding, not a create — dedupe downstream.
  Mapped to a content-less `progress` chunk carrying the four fields in
  `meta`. No UI affordance yet; the obvious one is a PR link in the
  session header. *Gotcha:* the fields are **scraped from captured
  command output** (last PR-shaped URL printed), which can include hook
  output or a file the same command catted — a display hint, not a
  verified identity. Never send credentials to `url` on its strength;
  `provider` is an open set too.
- **Extended thinking (Claude Code)**: newer `claude` emits two distinct
  thinking signals, handled in `mapClaudeLine`:
  1. `{"type":"system","subtype":"thinking_tokens","estimated_tokens":N,
     "estimated_tokens_delta":D}` — fires repeatedly (~every 150 tokens)
     while the model reasons. Mapped to a **content-less** `progress`
     chunk with `meta.contentType="thinking_tokens"` +
     `meta.estimatedTokens`/`estimatedTokensDelta`. Content-less so it
     never renders as a junk row; the web (`ActivityPill`) reads the
     running max from `meta` to show a live "🧠 N" counter in the capsule
     while the turn is running. *Gotcha:* before this was handled, the
     event fell through and surfaced as a literal "system" progress row.
  2. `thinking` / `redacted_thinking` content blocks on `assistant`
     messages (text in the `thinking` field, **not** `text`). Mapped to a
     `progress` chunk with `meta.contentType="thinking"` (+ `redacted:true`
     for the encrypted variant). Deliberately **not** a `delta` chunk:
     post-tool deltas get concatenated into the visible final answer by
     `splitDeltas`, so emitting reasoning as a delta would leak private
     thinking into the reply. The web renders these as labelled "Thinking"
     rows in the activity timeline. Cursor CLI (`mapCursorLine`) does not
     yet mirror this. *Big gotcha (verified empirically against `claude`
     2.1.167):* on **Opus 4.7/4.8** the API defaults to
     `thinking.display: "omitted"`, so the `thinking` field arrives
     **empty** with only a `signature` (the multi-turn/tool-use
     verification token, not reasoning text). On **Opus 4.6 / Sonnet 4.6**
     the default is `"summarized"` and the field is populated. Claude Code
     inherits the model's default, exposes no CLI flag to override it, and
     the sidecar only wraps the CLI — so it cannot force summarized
     thinking. Net: the `thinking_tokens` counter works on every model,
     but "Thinking" text rows only populate on models that return
     summarized thinking (run the agent on 4.6/sonnet-4.6 to get them).
     The empty block is expected, not a bug; the `if s != ""` guard
     suppresses it so no blank rows render.
- **Task tools (Claude Code ≥ 2.1.x)**: newer `claude` plans with
  `TaskCreate`/`TaskUpdate`/`TaskList` instead of `TodoWrite`. Unlike
  `TodoWrite` — where every call carried the FULL todos array in its
  input — these are **incremental**: `TaskCreate` input is one task's
  `{subject, description, activeForm?}` and the assigned id appears
  *only in the result text* (`"Task #7 created successfully: …"`);
  `TaskUpdate` is `{taskId, status?, subject?, …}` with statuses
  `pending|in_progress|completed|deleted` (deleted = permanent removal);
  `TaskList` results are plain text lines `#1 [in_progress] Subject`
  with optional `(owner)` / `[blocked by #N]` suffixes, or
  `"No tasks found"`. `taskListState`
  (`packages/sidecar/internal/adapter/claude_tasks.go`) replays this
  traffic — stash the tool_use, apply at the matching *successful*
  tool_result — and the mapper follows each task result with a
  **synthesized full-list TodoWrite chunk**
  (`meta.tool="TodoWrite"`, `meta.synthesized=true`,
  `meta.id=<tool_use_id>+":todos"`) so `TodoWindow` renders both
  generations of the tool through one code path. Subjects learned from
  tool *inputs* are authoritative; subjects parsed from `TaskList`
  output are best-effort (the owner suffix is not strippable without
  ambiguity) and never overwrite them. A `TaskList` resync also heals
  the post-`--resume` case where tasks predate the sidecar run; until
  then an update to an unknown id renders a `Task #<id>` placeholder.
  The raw `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` pills are
  hidden from the activity timeline (`isDedicatedPanelTool` in
  `ActivityPill.tsx`) since the synthesized snapshot already drives the
  panel. All shapes verified empirically against `claude` 2.1.170.
- **File-edit diffs**: every adapter (Codex, Claude Code, Cursor CLI)
  shares the snapshot-then-diff machinery in
  `packages/sidecar/internal/adapter/filediff.go`. The flow is uniform:
  on the tool *start* event the adapter calls
  `state.RememberBefore(toolID, absPath)` to snapshot the file, and on
  the matching tool *result* event it calls `state.BuildDiff(toolID,
  kind)` which re-reads the file and returns a unified diff. The diff
  is emitted as the result chunk's content with `meta.isDiff: true`,
  which the web UI renders with per-line colors via the shared
  `components/ui/DiffBlock.tsx` (used both inline in `ToolPill.tsx` and,
  aggregated per file for the last turn, in `DiffPane.tsx`). Snapshots are scoped to a single Execute() and use
  256 KiB / NUL-byte / 400-line caps to keep payloads sane. If a
  snapshot fails (binary, too big) we silently fall back to the
  adapter's plain-text result. When adding a new adapter, identify
  its file-modifying tools (see `isFileEditTool` in `claude_code.go`
  for the canonical list) and call the same two `fileEditState`
  methods — do **not** re-implement diffing per adapter.
- **Attachments are two separate problems; S3 only solves one**. A file
  attached to a turn has to (a) be *persisted* so the transcript
  re-renders it, and (b) be *delivered* to the **sidecar host's disk** so
  the CLI can read it — the CLI runs on the sidecar's machine, not the
  server. S3/MinIO handles (a). For (b) the sidecar pulls each file over
  **HTTP from the server** (the server is the S3 gateway), NOT directly
  from MinIO — because Argus sidecars run on arbitrary remote hosts that
  typically can't reach a cluster-internal bucket, but already reach the
  server. The bytes **never ride Redis**: only `Command.attachments`
  refs (id/filename/mime/size/token) travel the runner cmd stream, so the
  MAXLEN-trimming gotcha doesn't apply. If you ever want the sidecar to
  pull presigned-direct from S3 (server out of the byte path), gate it on
  the bucket being reachable from every sidecar host.
- **Image vision is uniform-prompt-path + one per-adapter flag**. The
  cross-adapter floor is the prompt preamble: every agentic CLI opens a
  file whose path it's told, and — verified empirically against the real
  CLIs — `claude -p` over stdin **and** `cursor-agent -p` attach a
  path-mentioned image as *vision* (not just a text read). Codex is the
  one exception: `codex exec` needs its native `--image <path>` flag for
  vision (a bare path mention can be read as text), so `codex.go` emits
  `--image` for every `image/*` attachment with a `LocalPath`. When
  adding an adapter, you get file access + (claude-style) image vision
  for free via the preamble; only wire a native image flag if that CLI
  has one. (Claude's *Read tool* is unreliable for images — several
  upstream issues — but we never depend on it; the path-in-prompt route
  is the documented, working one.)
- **Attachment lifecycle is keep-for-session; S3 orphans are a TODO**.
  Files stay under `.argus/uploads/` and in S3 for the life of the
  session so `--resume` turns can re-reference them. Deleting a command
  removes the `Attachment` rows but the service only best-effort deletes
  the S3 object on the upload-failure
  path — a periodic orphan sweep (objects whose row is gone, and unlinked
  `commandId IS NULL` uploads abandoned before send) is a follow-up.
- **Live file tabs (frontend)**: an open file tab re-reads itself when a
  CLI writes the file. Entirely client-side — the signal already ran end
  to end, `FileViewer` just cached forever (`if (cached) return`).
  `fsWatcher` fires on content edits, not only create/delete: verified
  against the real watcher that an in-place rewrite, an atomic
  write-temp-then-rename, AND a 5-write burst each produce exactly one
  debounced dir nudge.
  Flow: `fs:changed` → `useFileTabAutoRefresh` (mounted in `SessionPanel`)
  → `fileTabsStore.invalidateDir` bumps `revisions[key]` for every open
  tab in that dir → the bump is in `useFetchFileContent`'s dep array,
  which is what re-reads the file.
  **The traffic budget is the whole design.** `fs-read` responses ride
  the byte-capped `lifecycle` stream (MAXLEN 500 *entries*, ≤1 MB each,
  shared with heartbeats on a ~30 MB Redis) — the same budget the
  "Redis fills up" incident blew. Four things bound it, and none are
  decoration:
  1. Only the FOCUSED tab's `FileViewer` is mounted (`SessionPanel`'s
     `activeFile ? <FileViewer/> : <StreamViewer/>`), so at most one file
     per dashboard is ever in flight. Background tabs just carry a bumped
     revision and re-read when you click them.
  2. `contents[key]` records the `revision` it was read at, so
     re-focusing a tab does NOT re-read. Drop that and tab switching
     itself becomes fs-read traffic.
  3. A 400 ms trailing debounce on top of the sidecar's own 250 ms.
  4. Nothing invalidates while `document.hidden`; dirs stay pending and
     flush on the way back to visible.
  Known-and-accepted: `fs:changed` is DIRECTORY-granular (the sidecar
  drops the filename), so a sibling write refreshes your file too. Making
  it exact means putting the basename on the wire across sidecar +
  shared-types + server + web + iOS — considered and deferred, since (1)
  already bounds the cost and the fallback path such a change would need
  is exactly today's behaviour.
  UX rules the implementation must keep: refresh is
  stale-while-revalidate (never flip a readable file to a spinner —
  `TextViewer` deliberately does not `setHtml(null)` on re-highlight);
  `scrollTop` is captured before the swap and restored in a *layout*
  effect; a cited `line` re-applies its marker on every re-highlight but
  only re-scrolls when the citation itself changed; and a FAILED refresh
  keeps the last good render rather than showing an error, because an
  atomic rename leaves a window where the path briefly doesn't resolve.
- **Live file tabs, iOS side**: same feature, different shape, because
  `FilePreviewSheet` is a MODAL SHEET with no cache — `@State result`
  dies on dismiss and only one file is open at a time. So none of the
  web's `revisions` / stamped-content bookkeeping is needed; the "only
  the focused file refetches" bound is structural. Three iOS-specific
  problems it does have, none of which are transcription:
  1. **`FSChangedPayload` has no timestamp** (`{path, machineId,
     workingDir}`) and is Equatable, so two consecutive writes to one
     directory are an identical value and `.onChange(of:)` — which fires
     only on inequality — swallows every repeat. Observers watch
     **`AppModel.fsChangeSeq`** and read the **`fsChanges`** batch. This
     also silently affected the inspector's file tree before the counter
     existed. *Second-order gotcha, found on device:* the counter must
     advance once per FLUSH, not per event. Bumping it per event let a
     burst advance it several times inside one SwiftUI frame, which
     trips the runtime fault `onChange(of: Int) action tried to update
     multiple times per frame`. `AppModel.scheduleFSFlush` accumulates
     into `pendingFSChanges` and publishes once per main-actor hop, so a
     burst is one observable update carrying every changed directory —
     which is why consumers iterate a batch instead of reading a single
     latest payload.
  2. **The project room is often not joined when the sheet opens.** Only
     `InspectorPane` joined it, and the inspector is
     `.inspector(isPresented:)` — routinely closed on iPhone. But the
     sheet also opens from chat citations / FileChips in `SessionView`,
     where nothing else holds the room. The sheet now joins it itself,
     which is only safe because `StreamClient` refcounts (below).
  3. **`TextFileView` highlighted only on appear** (bare `.task`), so a
     refreshed file would render new text under the OLD file's colors —
     content and highlight are two separate arrays here, unlike the
     web's single shiki HTML blob. Now `.task(id: HighlightKey)`, which
     also folds in the former separate colorScheme observer.
  Scroll is held via `.scrollPosition(id:)` + `.scrollTargetLayout()`
  (iOS 17) rather than the web's `scrollTop` capture/restore.
- **Project WS rooms are refcounted on BOTH clients** — `lib/ws.ts` on
  web, `StreamClient` on iOS (`projectRooms: [ProjectRoomKey: Int]`,
  replayed by `rejoinProjectRooms()` from `AppModel`'s `.connected`
  handler). iOS deliberately does NOT replay from the socket's own
  connect callback: SocketIO is a `@preconcurrency` import so those
  closures run outside the actor and must only touch `continuation` —
  which is why every other handler in that file does exactly that.
  `ProjectRoomKey` is a file-scope Hashable struct, not nested in the
  `@MainActor` class (nested types inherit that isolation, which fights
  `Sendable`) and not a joined string (`("a","b/c")` and `("a/b","c")`
  would collide). Details of the web side:
- **Project WS rooms are refcounted (`lib/ws.ts`)**: `joinProject` /
  `leaveProject` count holders and only emit `subscribe:` /
  `unsubscribe:project` at the 0↔1 edges. Socket.io's `leave` is not
  refcounted, so the first unmounting holder used to kick the socket out
  of the room and silently starve the others of `fs:changed` /
  `git:changed`. This was latent — `ContextPane` renders FileTree /
  GitLogPanel / ProgressPane as mutually exclusive tabs, so only one ever
  held a room — and went live the moment `useFileTabAutoRefresh` added a
  holder that has to outlive the Files tab. The same map is replayed on
  `connect`: rooms are per-CONNECTION, and nothing re-joined them after a
  reconnect, so a network blip used to stop live updates until the
  subscriber happened to remount. `resetSocket` clears the map — every
  holder is an effect that re-joins on its next mount, and a surviving
  count would suppress that.
- **Attachment viewing is unified with the file tree (frontend)**: a sent
  attachment opens as a `FileViewer` **tab** on double-click — same
  gesture and destination as the Files panel, not a floating modal.
  `fileTabsStore.OpenFile` is a `file | attachment` union; `openAttachment`
  keys tabs `att:<id>`. `FileViewer` renders both sources through the
  shared `FileContentView` (text / markdown / HTML / image / binary);
  attachments add a PDF-in-iframe path and fetch text-like files over HTTP
  from the tokenized url (image / PDF render straight from the url).
  Opening a tab swaps `StreamViewer` out, which used to snap the chat to
  the bottom on close — `StreamViewer` now records `{top, atBottom}` per
  session in a module-level `scrollMemory` **inside onScroll** (NOT at
  unmount: a tearing-down node reports `scrollTop`/`clientHeight` as ~0,
  which reads as "at bottom" and corrupts the saved position) and restores
  it on remount. The composer's pre-send image chips keep a quick
  `ImageLightbox` (floating zoom) — an unsent file has no session tab to
  open into.
- **Token-level UI re-render**: `StreamViewer` concatenates all `delta`s
  into a single string per command and re-renders that block on every chunk.
  This is fast enough up to a few hundred KB; if you hit perf issues,
  switch to an append-only DOM strategy.
- **Auth on the WS handshake**: the JWT is read from `auth.token`. We don't
  ship per-event RBAC yet — anyone with a valid token sees everything.
- **`getSessionChunks` re-fetch on reconnect**: the client passes
  `afterSeq=lastSeq`; the server's REST endpoint hits Postgres, not Redis,
  so it works even after Redis stream trimming.
- **Archive vs destroy vs delete**: sessions and machines support
  soft-archive via an `archivedAt DateTime?` column —
  `POST /sessions/:id/archive` hides a row from default lists without
  losing history. Pass `?includeArchived=true` to bring them back.
  *Projects* are server-backed rows (`Project` table); archiving a
  project from the sidebar cascades client-side — walk the project's
  sessions and `POST /archive` on each, then set `archivedAt` on the
  `Project` row (with a snapshot of the session IDs flipped, so restore
  only un-archives those). There is no project or session hard-destroy;
  archive and re-create instead. (There is no agent to archive or destroy
  — the entity is retired.)
  Machines are **soft-deleted**, not destroyed: `DELETE /machines/:id`
  sets the sticky `Machine.deletedAt` tombstone, flips status offline,
  suffixes the `@unique` `name` (so a fresh install can reuse the human
  name), and emits `machine:removed`. **No rows are deleted** — the
  machine's projects/sessions/commands/chunks/terminals survive untouched
  and stay viewable through the user-scoped session list; only the
  *active* surfaces (machine list, sidebar) hide them. Safe at any status,
  so there's no online guard. `deletedAt` differs from `archivedAt`
  precisely because the `machine-register` handler resets `archivedAt` to
  null on every re-register: the lifecycle consumer instead *ignores* any
  event (`machine-register` skips the upsert; `machine-heartbeat` is an
  `updateMany` filtered on `deletedAt: null`) from a tombstoned machine
  and never clears `deletedAt`, so a still-running or restarting sidecar
  can no longer resurrect it. The delete is terminal — there is no
  un-delete endpoint or UI. The periodic sweeper only flips stale machines
  to `offline` — it never reaps rows.
- **Terminal == remote shell access**: ticking "attach interactive
  terminal" when creating a project/session lets *any* dashboard user
  spawn shells on that host as the sidecar daemon's UID. Treat this as
  equivalent to handing out SSH; only
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
  server force-closes every `opening|open` terminal for that machine
  with reason `"link disconnected: ..."`. We do NOT try to resume
  PTYs across reconnects — the bytes buffered on the sidecar side
  during the outage would desync from the browser's xterm state and
  the rehydration logic is not worth the complexity. Users just
  re-open a terminal when the sidecar comes back.
- **Terminal transcripts are not persisted**: the `Terminal` row stores
  metadata only — never the keystroke/output transcript. Adding one
  would balloon storage fast and risks capturing secrets typed into the
  shell. If you need replay, add a separate, opt-in `TerminalTranscript`
  table gated behind a per-project flag (mirror the existing
  `Project.supportsTerminal` plumbing).
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
  the new binary (and, best-effort, refresh the `argus-bg` companion
  from the same release — see the argus-bg lockstep note above), then
  picks one of three handoff strategies *itself* based on environment
  hints — the server has no say:
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
- **Sidecar version strings have a tag prefix; strip on BOTH sides
  before comparing**: the running sidecar reports its `main.Version`
  ldflag verbatim, which the release workflow injects as the full
  tag name (`argus-sidecar-v0.1.11`), so that's what lands in
  `Machine.sidecarVersion` from `machine-register`. The GitHub
  latest-tag fetch in `SidecarUpdateService.fetchLatestTag` strips
  the prefix to a bare semver. A naive
  `compareSemver(machine.sidecarVersion, latest)` compares
  `"argus-sidecar-v0.1.11"` against `"0.1.11"` — the first base
  parses as `parseInt("argus") || 0` and the comparator decides
  the sidecar is forever behind, so the badge sticks on
  "update from argus-sidecar-v0.1.11 to 0.1.11" indefinitely. Use
  `stripSidecarPrefix` (exported from `sidecar-update.service.ts`)
  on every value sourced from `Machine.sidecarVersion` or a
  lifecycle event before passing it to `compareSemver` or surfacing
  it in a UI string. The write path in `MachineService` also
  normalizes on register so newly-stored rows are bare; the strip on
  read is defense-in-depth for rows written before that landed.
- **Task-completion notifications hook `session:status`, not
  `command:updated`**: the notifier in `App.tsx`'s `onSessionStatus`
  handler reads the prior session status BEFORE upserting and fires
  on the `active → done|failed` transition. The earlier-and-obvious
  choice of hooking `command:updated` is wrong: that event is
  emitted to room `session:{id}` (see `stream.gateway.ts:147`),
  which the browser only joins while `SessionPanel` is mounted —
  navigating away triggers `leaveSession` and the user stops
  receiving command updates entirely, so notifications would never
  fire in exactly the case they're meant for. `session:status` goes
  to `user:{userId}` (always joined). Status semantics:
  `status` is lifecycle-only (`active`/`idle`/`failed`) and a
  separate `unread` boolean drives the sidebar dot — the dot shows
  iff `unread`, colored by `status` (emerald=idle, red=failed; amber
  while `active`). `result-ingestor.service.ts` lands success at
  `idle` + `unread:true` and failure at `failed` + `unread:true`;
  `SessionPanel`'s effect clears `unread` (via `POST /sessions/:id/seen`,
  which now flips ONLY `unread`, leaving `status` intact) the moment
  the user opens the session. So the notification trigger is
  `prevStatus === 'active'` AND the incoming event is a terminal,
  unread result (`status !== 'active' && unread`) — `unread` also
  filters out the `markSeen` echo, so opening a session can't
  re-notify. Fork-created sessions land directly at `idle` with
  `unread:false` (no run yet, nothing to acknowledge). Reading
  prev-status before applying prevents re-fires on idempotent
  re-emits (the ingestor emits `active` on every interim chunk).
- **Session-status echoes are `updatedAt`-ordered to kill a
  dot-resurrection race**: the dot used to get stuck because the
  status lived only on the server and arrived over two unordered
  channels — the `session:status` WS event and REST `loadSession`
  responses. A background prefetch (`App.tsx` `onAgentStatus`, fired
  the instant a turn completes) could issue a `loadSession` whose DB
  read captured the pre-`markSeen` state and then land AFTER the
  `markSeen` clear, resurrecting the dot until a hard refresh. Fix:
  the `session:status` payload carries `unread` + `updatedAt`, and
  `sessionStore`'s `applySessionStatus`/`loadSession`/`upsertSession`
  reject any write whose `updatedAt` is older than what's already
  stored (`isStaleUpdate`). Every server status write bumps
  `updatedAt` (Prisma `@updatedAt`), so `markSeen` always wins over a
  stale snapshot. `applySessionStatus` also patches the sidebar
  `sessions` map directly (the old handler dropped the update unless
  the session was in the `entries` cache), so dots clear for
  unopened sessions too. `Notification.requestPermission()`
  MUST run inside a user-gesture handler —
  `UserPanel.NotificationToggle` calls it directly from the click
  handler, so don't refactor through `useEffect` without preserving
  the synchronous call chain. Suppression rule is inline in the
  handler: `(tabVisible AND activeSessionId === p.id)` — any other
  combination earns a notify. The chime uses `AudioContext`
  oscillators (no bundled asset) which can be silently blocked by
  autoplay policy on browsers that haven't seen a user gesture yet,
  but on a logged-in dashboard that's effectively never.
- **Interactive controls must not render inside `<label>`** (`ui/Select`,
  adapter chips): a `<label>` implicitly associates with its FIRST
  labelable descendant, then (1) re-dispatches clicks on non-labelable
  areas to it — selecting a dropdown option re-toggled the panel open;
  clicking empty space next to the adapter chips selected the first
  chip — and (2) propagates `:hover` styling to it, so hovering blank
  field space lit up the first chip as if selected. The click half is
  engine-dependent, which made it look like a Safari bug: Blink skips
  forwarding when propagation is stopped (the panel's
  `stopPropagation` "fixed" Chrome), WebKit runs label activation as
  the click's default action and forwards regardless. Structural fix:
  the dialog's `Field` takes `as="div"` for any children that embed
  their own interactive controls (model picker, adapter chips). Keep
  it that way.
- **Model catalogs describe; they never gate**: selections pass
  through `Command.options` → adapter argv with NO validation against
  the catalog — on the server, the sidecar, or anywhere else. This is
  deliberate: it keeps stale catalogs harmless, makes the free-text
  "custom…" model id a first-class path, and matches the entitlement
  reality (Claude Code's `sonnet[1m]` is plan/credit-gated with no way
  to pre-check; a bad choice must surface as a turn error). Resist
  adding validation here when something "looks wrong" — degraded
  pass-through is the designed behavior.
- **Cursor slug parsing: at most ONE effort token, labeling only**:
  `models_cursor.go` groups cursor's ~110 flat slugs into families by
  stripping variant segments right-to-left (`fast`, `thinking`, and a
  single effort token, with `extra-high` counting as one token across
  two segments). The one-effort rule is load-bearing — `max` is an
  effort suffix in `claude-fable-5-max` but part of the *model name*
  in `gpt-5.1-codex-max-low`, and segment order flips between
  generations (`claude-opus-4-8-thinking-high` vs
  `claude-4.6-opus-high-thinking`). Crucially the parser only ever
  produces LABELS (`family`/`variantLabel`); the dispatched value is
  always the exact slug from the CLI's own list, so a parsing miss is
  a cosmetic grouping bug, never a dispatch failure. Don't "improve"
  it into slug recomposition.
- **Claude Code's model catalog is a compiled-in table**: the CLI has
  no list-models surface (no subcommand; the stream-json control
  protocol rejects `supported_models` and friends — probed on 2.1.170),
  so `models_claude.go` hardcodes the documented aliases + effort/1m
  facets. Safe because aliases track the latest models and `--effort`
  falls back gracefully, but the facet matrix should be re-checked
  against https://code.claude.com/docs/en/model-config when models
  launch. Codex's catalog command lives under `codex debug models` —
  machine-readable JSON but nominally a debug surface; the parser is
  defensive and any failure degrades to the free-text input.
- **Context-window lookup is hand-maintained**: the donut on the
  session header's `UsageBadge` reads its denominator from
  `packages/shared-types/src/contextWindow.ts`, a hardcoded family →
  window map matched by lowercased substring on the active model id.
  The "current context used" numerator is the LATEST `final` chunk's
  `inputTokens + cacheReadTokens + cacheWriteTokens` — not a sum across
  turns — because each CLI re-sends the full history on `--resume`,
  so the most recent prompt size IS the live context. **Gotcha:** for
  claude-code the `result` event's top-level `usage` is the *cumulative
  whole-turn aggregate* (summed over every API round-trip a tool-use turn
  makes), which overcounts the live context by ~the round-trip count and
  pins the ring near 100%. So the ring sources its numerator via
  `parseContextUsage`, which for claude-code reads the final single call
  from `usage.iterations[-1]`; `parseUsage` (used by `useSessionUsage` and
  the server-side `/me/usage` aggregation) intentionally keeps the
  cumulative aggregate, which is the correct per-turn cost/usage total.
  codex (`turn.completed.usage`) and cursor-cli expose only a turn-level
  total in `exec --json`, so their rings can still overcount on multi-call
  turns — codex's per-call figure lives in the richer `app-server`
  protocol (`thread/tokenUsage/updated` → `tokenUsage.last`), not adopted
  here. When a new model
  family ships (Anthropic / OpenAI / Cursor announcement), bump the
  table as `chore(shared): update model context windows` — verify
  against the upstream announcement, not release-note rumors. Unknown
  models return `null` so the ring just hides instead of rendering a
  misleading percentage; the bare ↑/↓ arrows stay visible.
- **`Command.usage` is denormalized at write time**: the result-ingestor
  calls `parseUsage` once when each turn finalizes and stores the
  normalized `TokenUsage` JSON on the Command row. `/me/usage` SUMs
  that column in Postgres instead of re-parsing every `final` chunk's
  raw `meta`, which is what made the panel slow for heavy users. It
  emits all three windows (7-day / 30-day / lifetime) from a single
  scan via conditional aggregation — the rolling buckets are
  `SUM(...) FILTER (WHERE c."createdAt" >= NOW() - INTERVAL 'N days')`,
  now-anchored not calendar-aligned, reusing the
  `@@index([sessionId, createdAt])` the activity grid already leans on.
  The optional `costUsd` / `durationApiMs` undefined-vs-zero contract
  is enforced *per window* (a `*_rows` COUNT scoped to the same
  filter), so a recent codex-only stretch never shows a spurious
  "$0.00" even when the lifetime total has a real cost.
  Pre-denormalization rows are populated by SQL migration
  `6_backfill_command_usage`, which mirrors `parseUsage`'s adapter
  switch one-for-one — if you change `parseUsage`'s output shape,
  history won't be retroactively recomputed; ship a follow-up data
  migration. NULL on a completed Command row means "no usage payload"
  (cancellation, error, custom adapter that doesn't emit one), not
  "in flight" — the `/me/usage` query filters to `usage IS NOT NULL`
  so NULLs cost nothing.
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
- Pool routing ("run this on any machine that has CLI type X") — would
  need a type-scoped consumer group across machines; not exposed yet.
- Pre-commit hooks (ruff/eslint).
- **Attachments — known debt** (the file/image feature is complete and
  verified end-to-end for claude `-p`/stdin and codex `--image`; these are
  the deferred edges):
  - **S3 orphan sweep.** Deleting a Command cascades its `Attachment`
    rows, but the MinIO/S3 objects are only best-effort removed on the
    upload-failure path. Need a periodic sweep for (a) objects whose row
    is gone and (b) unlinked uploads (`commandId IS NULL`) abandoned in
    the composer before send.
  - **Sidecar `.argus/uploads/` pruning.** Pulled files are kept for the
    session (so `--resume` can re-reference them) but never deleted — in
    practice keep-forever on the sidecar host's disk. Add an
    age/size-bounded prune (they're hidden + gitignored, so it's only disk
    usage).
  - **`cursor-cli` image vision unverified.** claude (path-in-prompt) and
    codex (`--image`) are confirmed against the real CLIs; cursor's
    path-mention vision is documented-but-unproven (no cursor-agent on the
    test box). Smoke-test before claiming cursor image support.
  - **No server-side attachment tests.** The sidecar has unit tests
    (pull / sanitize / preamble); the `attachment/` module (upload,
    tokenized download, link-and-validate) has none.
  - **New-session inline prompt drops attachments.** `POST /sessions`
    with `body.prompt` calls `dispatch()` without `attachmentIds`
    (`session.controller.ts`). The web never hits this with files (first
    message goes through `/commands`), so it's latent — but forward the
    ids there for completeness.
  - **Server is in the byte path.** The sidecar pulls each file from the
    server (S3 gateway) and the browser displays from it; presigned
    direct-from-S3 is the scale path, gated on the bucket being reachable
    from every sidecar host (see the two-leg gotcha).

## When you change something

- **Wire format** → update `packages/shared-types/src/protocol.ts` **and**
  `packages/sidecar/internal/protocol/protocol.go`.
- **Streaming UX** → update `StreamViewer.tsx` and (if you add a new chunk
  kind) every adapter mapper that should emit it.
- **DB schema** → add a Prisma migration, regenerate the client, and update
  the relevant DTO mappers (`SessionService.toDto`, `CommandService.toDto`,
  `MachineService.toDto`).
- **Architecture** → update this file.
