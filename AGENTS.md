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
  `DELETE /machines/:id/agents/:agentId`, `DELETE /machines/:id`) and
  emits `machine:upsert` / `machine:status` / `machine:removed` /
  `agent:spawn-failed` over WS. Also publishes `create-agent` / `destroy-agent` commands on
  `machine:{mid}:control`.
- `agent-registry/` — `Agent` CRUD: list, get, archive/unarchive, plus
  the shared `agentToDto` mapper. Lifecycle ingestion lives in
  `machine/`; this module is purely about the persisted Agent row.
- `session/` — CRUD for sessions; resolves `externalId` so each subsequent
  turn carries it back to the sidecar for `--resume`.
- `command/` — persists commands, `XADD`s to `agent:{id}:cmd`, handles cancel.
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
- `machine/background-task.{service,controller}.ts` — in-memory
  registry of every active + ended background task, populated by the
  service's own XREADGROUP loop on `streamKeys.background` (the
  dedicated `agent:background` stream; deliberately separate from
  `agent:lifecycle` because a fast tqdm bar emits 20+ events/sec and
  would otherwise trim heartbeats / fs-changed / sidecar-update
  progress out via MAXLEN). Keyed by `(machineId, workingDir,
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
  No DB persistence — JSONL on the agent's disk is authoritative if
  you need history.
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
    Working-dir-less agents fall back to a temp dir.
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
    agent's workingDir, always strip `.git` AND `.argus/`, and
    respect gitignore. `fsWatcher` registers one fsnotify watch per
    non-ignored dir and coalesces events into 250 ms-debounced
    fs-changed emits. `git.go` reads `.git/HEAD` (and resolves the
    worktree-pointer file form) without shelling out to `git` or
    pulling in a Go git lib — its output is attached to every
    fs-list response so the dashboard's branch badge refreshes for
    free on every tree refetch.
  - `progresswatch.go` — tertiary fsnotify watcher rooted at
    `<workingDir>/.argus/progress/`, picking up the JSONL stream
    `argus-bg` writes when wrapping a long-running command. Each
    decoded line becomes one of the three
    `BackgroundTask{Started,Progress,Ended}Event` lifecycle frames,
    forwarded on `agent:lifecycle` so the dashboard's per-project
    Progress tab can render live status for detached background work
    the agent's PTY would otherwise never see (anything backgrounded
    with `&` / `nohup` flows only to the agent's log files, not to
    the PTY the sidecar captures). `bgEvent` is the wire format on
    disk; the supervisor decorates it with machineId / agentId /
    workingDir before publishing. Soft-fails the same way fsw / gitw
    do — a missing or read-only progress dir just means the tab
    stays empty.
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
  `buildShellEnv` augments the spawned shell's environment with two
  hooks the Progress extension depends on: prepends the sidecar's own
  bin directory to `PATH` (so `argus-bg` is reachable without an
  absolute path) and exports `ARGUS_PROGRESS_DIR` pointing at the
  agent's `<workingDir>/.argus/progress/`, which is also where the
  per-agent `progressWatcher` is listening.
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
  ANSI-coloured, and HH:MM:SS-eta variants.
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
  normalisation on the off chance an older sidecar is in front. See the
  AGENTS.md note on stream-json drift.
- `components/Sidebar.tsx` — flat project → session tree. Top level
  groups agents by `(workingDir, machineId)` — same path on different
  machines lives on different physical filesystems, so they get
  separate rows. Each project row shows a folder icon + label +
  small machine glyph; sessions whose agent has no `workingDir`
  fall into a per-machine `no project` bucket. **A project expands
  directly into its sessions** — there is no agent row in the tree.
  Each `SessionRow` leads with the agent type icon
  (`AgentTypeIcon` driven by `agents[s.agentId]?.type`), so the
  user can tell a claude session from a codex one without the agent
  layer being visible. **Creation hierarchy** mirrors the tree: the
  bottom `MachineList`'s hover `+` opens `CreateProjectPopover`
  (name + workingDir + terminal default — no adapter), which writes
  a placeholder into `useProjectStore`; the project row's hover `+`
  opens `CreateAgentPopover` in `asSession` mode, which collects
  adapter + session name only, then **auto-vivifies** the agent —
  reuses an `existingAgents` entry of the chosen type within the
  project if there is one, otherwise creates a new agent with an
  auto-generated `${type}-${randomHex}` name in the background,
  then creates a session titled with the user's input and navigates
  to it. The agent layer is implementation detail in the sidebar:
  multiple sessions of the same type in one project share a single
  supervisor process. Projects are derived in two passes by
  `groupProjects()`: first from `agentStore.order` (so any agent's
  workingDir surfaces a row even with no placeholder), then
  overlaid with `useProjectStore` placeholders (which take over the
  row's label and let empty projects render before their first
  agent). Same `(machineId, workingDir)` key on both sides, so a
  placeholder and its later agents collapse into one row.
  Placeholders are client-only and persisted under `argus.projects`
  — promote to a server entity when the flow stabilises. Archiving
  a project from its hover action cascades client-side: every
  non-archived session under every non-archived agent is archived
  via REST (skipping items already archived individually), then
  the agents themselves, then the placeholder's `archivedAt` is set
  together with a snapshot of the IDs the cascade actually flipped
  (`archivedAgentIds` + `archivedSessionIds`). Restore consults the
  snapshot and only un-archives those IDs — so a session the user
  archived individually BEFORE the project archive stays archived
  after restore. `Promise.allSettled` is used on the archive path
  so per-item failures don't poison the snapshot; the restore path
  uses per-item `.catch` so a since-destroyed row 404s without
  blocking the rest. The store auto-creates a placeholder for a
  purely agent-derived row so the project keeps a stable identity
  to restore from. Legacy placeholders archived before the
  snapshot existed (both snapshot fields `undefined`) fall back to
  a broad restore that un-archives everything currently archived
  in the project — accept the bluntness for backward compatibility.
  The `showArchivedAgents` toggle reveals archived placeholders as
  well as archived agents. Per-project show-archived state (the
  eye toggle, which moved from the agent row to the project row in
  the flatten) lives in `uiStore.showArchived` keyed by
  `project.key` — old agent-id-keyed entries from before the
  flatten survive as harmless orphans. Expansion state lives in
  `uiStore.expanded` keyed by `proj:<machineId>::<workingDir>`
  (default open; the project popover force-opens its new row on
  submit in case it was previously toggled closed). The synthetic
  `no project` bucket hides the project-row `+` since it has no
  path to anchor an agent against — agents without a workingDir
  still get created through `MachinePanel`'s free-form popover,
  which keeps using `CreateAgentPopover` directly in its default
  (agent-mode) form. Each project row's folder icon is itself a
  picker (`ProjectIcon`/`ProjectIconGlyph`) — clicking opens a
  6×5 letter grid plus a `reset to folder` action; the picked
  A-Z glyph persists to `LocalProject.iconKey` and renders in
  place of the default Folder in both the main sidebar and the
  rail. No auto-default from the project name — picking is what
  binds the letter to the project in the user's memory. Rename
  is the pencil action in the project row's hover stack and
  commits via `useProjectStore.add()` on the existing key
  (creates a placeholder for purely agent-derived rows).
- `lib/projects.ts` — shared `groupProjects()` derivation +
  `ProjectGroup` type consumed by both `Sidebar` and
  `SidebarRail`. Pure function over `(agentOrder, agents,
  localProjects, localOrder)`; callers pre-filter the orders for
  whatever archived-visibility posture they want.
- `components/SidebarRail.tsx` — collapsed-mode rail (48px wide).
  Renders one tile per project using the same `groupProjects()`
  derivation as the main sidebar, with `ProjectIconGlyph` for the
  glyph. Click jumps to the project's most-recent non-archived
  session across any of its agents. Archived projects/agents and
  the synthetic `no project` bucket are hidden — the rail is for
  active-state navigation, not history. Machine strip + logout at
  the bottom unchanged.
- `components/ContextPane.tsx` — right-pane companion to a session. Header
  shows agent identity + working dir + model. A collapsible `Details`
  block surfaces agent + session metadata (machine, status, version,
  working dir, registered, last seen, session title, external id,
  updated, model). The bottom region is tabbed: **Commits** (`GitLogPanel`),
  **Files** (`FileTree`), **Terminal** (`<TerminalPane>`), and — only when
  the Notes extension is on (`uiStore.notesExtensionEnabled`) and the agent
  has a `workingDir` — **Note** (`<NotePane>`).
- `components/MachinePanel.tsx` — `/machines/:id` route. Header with
  machine glyph + name + status dot + sidecar-update / new-agent buttons.
  Below the header: 2:3 grid with Host KV + Supports adapters on the
  left, agent list on the right. Each `AgentLine` shows `[type icon]
  name [verb] [workingDir]` with a hover-only destroy action.
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
  rules editor), and Extensions (opt-in features; currently just
  **Notes**). The on/off flag is an account-level preference persisted
  server-side via `GET`/`PUT /me/extensions` (a JSON map on `User`, so
  new extensions need no migration); `uiStore.notesExtensionEnabled` is
  a localStorage cache for synchronous, flash-free reads, reconciled
  against the server on bootstrap (`App.tsx`). Capped at `max-w-6xl`.
- `components/TerminalPane.tsx` — xterm.js bound to one agent. Owns the
  WebSocket plumbing, a debounced ResizeObserver for fit, base64 encoding
  on input, and a duplicate-seq guard on output. Renders inside the
  **Terminal** tab of `ContextPane` so we don't pay the xterm cost until
  the user clicks the tab.
- `components/NotePane.tsx` — free-form per-project scratchpad in the
  **Note** tab of `ContextPane`. A "project" has no DB row of its own
  (the sidebar derives projects from agents' `workingDir`s), so the note
  is keyed by the `(userId, machineId, workingDir)` triple in the
  `ProjectNote` table and reached via `GET`/`PUT /me/project-notes`
  (machineId + workingDir as query params). Two sessions in the same
  working dir edit the same note. Debounced autosave (~700 ms) rather
  than a Save button; byte-capped at `PROJECT_NOTES_MAX_BYTES`. Both the
  extension on/off flag and the note *content* are server-persisted per
  user (see `/me/extensions` and `/me/project-notes`), so they survive
  browser switches. Unlike `User.rules`, notes are personal scratch and
  are never fanned out to sidecars.

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
- **Attachments are two separate problems; S3 only solves one**. A file
  attached to a turn has to (a) be *persisted* so the transcript
  re-renders it, and (b) be *delivered* to the **sidecar host's disk** so
  the CLI can read it — the CLI runs on the agent's machine, not the
  server. S3/MinIO handles (a). For (b) the sidecar pulls each file over
  **HTTP from the server** (the server is the S3 gateway), NOT directly
  from MinIO — because Argus sidecars run on arbitrary remote hosts that
  typically can't reach a cluster-internal bucket, but already reach the
  server. The bytes **never ride Redis**: only `Command.attachments`
  refs (id/filename/mime/size/token) travel the `agent:{id}:cmd` stream,
  so the MAXLEN-trimming gotcha doesn't apply. If you ever want the
  sidecar to pull presigned-direct from S3 (server out of the byte path),
  gate it on the bucket being reachable from every agent host.
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
  (e.g. agent hard-delete cascade) removes the `Attachment` rows but the
  service only best-effort deletes the S3 object on the upload-failure
  path — a periodic orphan sweep (objects whose row is gone, and unlinked
  `commandId IS NULL` uploads abandoned before send) is a follow-up.
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
- **Archive vs destroy vs delete**: agents, sessions, and machines all
  support soft-archive via an `archivedAt DateTime?` column —
  `POST /agents/:id/archive` / `POST /sessions/:id/archive` hide rows
  from default lists without losing history. Pass
  `?includeArchived=true` to bring them back. *Projects* don't exist
  server-side yet; archive on a project row in the sidebar is a
  client-side cascade that walks the project's sessions and agents
  and POSTs `/archive` on each, then sets `archivedAt` on the
  `useProjectStore` placeholder (creating one if the row was purely
  agent-derived). Restore reverses the order. There is no project
  hard-destroy.
  *Hard-destroy* an agent via `DELETE /machines/:mid/agents/:agentId`:
  the server publishes a `destroy-agent` command, the sidecar tears
  the supervisor down and drops the cache entry, and the row is
  removed from Postgres (cascading via `onDelete: Cascade` on
  Session/Command/Result). This is the supported way to delete an
  agent — the sidebar's per-agent "trash" hits this. There is no
  separate destroy for sessions; archive and re-create instead.
  Machines are **soft-deleted**, not destroyed: `DELETE /machines/:id`
  sets the sticky `Machine.deletedAt` tombstone, flips status offline,
  archives the machine's agents (sets their `archivedAt`), suffixes
  the `@unique` `name` (so a fresh install can reuse the human name),
  and emits `machine:removed`. **No rows are deleted** — the agents'
  sessions/commands/chunks/terminals survive untouched and stay
  viewable through the user-scoped session list; only the *active*
  surfaces (machine list, sidebar) hide them. Safe at any status, so
  there's no online guard. `deletedAt` differs from `archivedAt`
  precisely because the `machine-register` handler resets `archivedAt`
  to null on every re-register: the lifecycle consumer instead
  *ignores* any event (`machine-register` skips the upsert;
  `machine-heartbeat` is an `updateMany` filtered on `deletedAt: null`)
  from a tombstoned machine and never clears `deletedAt`, so a
  still-running or restarting sidecar can no longer resurrect it. The
  delete is terminal — there is no un-delete endpoint or UI. The
  periodic sweeper only flips stale machines/agents to `offline` — it
  never reaps rows. Known quirk: a deleted machine's sidecar keeps
  running and its supervisors' per-*agent* register/heartbeat events
  still update those (already-archived, hidden) Agent rows; harmless,
  since they're filtered from every active view.
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
  `result-ingestor.service.ts` flips success to `'done'` (the unread
  marker the sidebar surfaces with a green dot + bold title) and
  failure to `'failed'`; `'idle'` is the post-acknowledgement steady
  state, reached after `SessionPanel`'s `markSeen` effect calls
  `POST /sessions/:id/seen`. So the notification trigger is
  `active → done`, not `active → idle` — by the time the user has
  opened the session, the status is already idle and we don't want
  to re-notify them about something they're looking at. Fork-created
  sessions land directly at `'idle'` (no run yet, nothing to
  acknowledge). Reading prev-status before upsert prevents re-fires
  on idempotent re-emits (the ingestor emits `active` on every
  interim chunk) and also prevents the `done → idle` transition
  from triggering a second notification, since the prev-status
  guard only matches `active`. `Notification.requestPermission()`
  MUST run inside a user-gesture handler —
  `UserPanel.NotificationToggle` calls it directly from the click
  handler, so don't refactor through `useEffect` without preserving
  the synchronous call chain. Suppression rule is inline in the
  handler: `(tabVisible AND activeSessionId === p.id)` — any other
  combination earns a notify. The chime uses `AudioContext`
  oscillators (no bundled asset) which can be silently blocked by
  autoplay policy on browsers that haven't seen a user gesture yet,
  but on a logged-in dashboard that's effectively never.
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
- Pool routing (`agents.{type}.commands` consumer group) for "any agent of
  type X" — the protocol/streams support it; the dashboard doesn't expose it
  yet.
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
    practice keep-forever on the agent's disk. Add an age/size-bounded
    prune (they're hidden + gitignored, so it's only disk usage).
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
    from every agent host (see the two-leg gotcha).

## When you change something

- **Wire format** → update `packages/shared-types/src/protocol.ts` **and**
  `packages/sidecar/internal/protocol/protocol.go`.
- **Streaming UX** → update `StreamViewer.tsx` and (if you add a new chunk
  kind) every adapter mapper that should emit it.
- **DB schema** → add a Prisma migration, regenerate the client, and update
  the relevant DTO mappers (`AgentRegistryService.toDto`, `SessionService.toDto`,
  `CommandService.toDto`).
- **Architecture** → update this file.
