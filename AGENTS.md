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
3. **Sidecar (`packages/sidecar`)** — small Go binary that wraps **one** CLI
   agent. Talks to the server *only* through Redis Streams. Each sidecar has a
   stable `id`.
4. **Bus** — Redis Streams. Five streams matter:
   - `agent:lifecycle`        — sidecars announce themselves and heartbeat.
   - `agent:{id}:cmd`         — server → that sidecar.
   - `agent:{id}:result`      — that sidecar → server (chunks, externalId).
   - `agent:{id}:term:in`     — server → sidecar (terminal open / input / resize / close).
   - `agent:{id}:term:out`    — sidecar → server (terminal output / closed).

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

- An **Agent** is a worker (a long-lived sidecar). "Who can do work."
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
- `agent-registry/` — consumes `agent:lifecycle`, persists `Agent` rows,
  sweeps stale agents every 15s (offline after 30s with no heartbeat),
  emits `agent:upsert` / `agent:status` over WS.
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
  and a single XREADGROUP consumer (`TerminalOutputConsumer`) across every
  agent's `term:out` stream. Bytes are base64 over the wire to survive JSON.
- `gateway/` — Socket.IO namespace `/stream`. Rooms: `user:{id}`,
  `agent:{id}`, `session:{id}`, `terminal:{id}`. Authenticates the handshake
  using the same JWT used for REST. The gateway is the **only** thing that
  emits live data to clients.
- `infra/redis/` — wrapper that owns *two* connections: one for blocking
  XREADGROUP, one for everything else (ioredis requires this).
- `infra/prisma/` — Prisma client.

### `packages/sidecar/internal/`

- `protocol/` — wire structs (mirror of shared-types).
- `config/` — YAML loader for `sidecar.yaml`.
- `bus/` — go-redis wrapper with `Publish`, `EnsureGroup`, `ReadMessage`, `Ack`.
- `adapter/` — `Adapter` interface and process-level **registry**. Each
  adapter file calls `Register(...)` from `init()`. The shared
  `clistream.Start` helper does the heavy lifting (spawn, line-buffered
  read, SIGTERM-then-SIGKILL cancel, final/error close).
- `lifecycle/` — registers, heartbeats, drains commands, dispatches each
  one to the adapter, forwards chunks back, ACKs Redis, deregisters. Also
  starts the terminal runner if `terminal.enabled` in YAML.
- `terminal/` — PTY runner using `github.com/creack/pty`. Subscribes to
  `agent:{id}:term:in`, multiplexes per-terminal goroutines (read pump +
  wait-for-exit), batches output (16 KB / 16 ms) onto
  `agent:{id}:term:out`. Enforces shell allowlist, max-sessions cap, and
  writes a `TERM=xterm-256color` env into every PTY.
- `cmd/sidecar/main.go` — flag parsing, signal handling, runner glue.

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
- **IDs**: sessions and commands use `cuid()`. Agent ids come from
  `sidecar.yaml` and **must** be stable across restarts.
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
- **Archive vs delete**: both `Agent` and `Session` support soft-archive via
  an `archivedAt DateTime?` column. There is **no in-app delete** for
  agents (the registry is append-only by design — deleting an agent would
  orphan its sessions/commands/chunks, and `Session.agentId` is
  `onDelete: Restrict`). Use `POST /agents/:id/archive` /
  `POST /agents/:id/unarchive` to hide an agent from the sidebar without
  losing history. The same pattern applies to sessions
  (`POST /sessions/:id/archive`). Archived rows are filtered out of
  `GET /agents` and `GET /sessions` by default — pass
  `?includeArchived=true` to get them back. When an archived sidecar
  re-registers via the lifecycle stream, its `archivedAt` is preserved
  (the upsert clause does not touch it), so the operator's hide decision
  is sticky across restarts.
- **Terminal == remote shell access**: enabling `terminal.enabled: true` in
  a sidecar YAML lets *any* dashboard user spawn shells on that host as
  the sidecar's UID. Treat this as equivalent to handing out SSH; only
  enable on hosts where every dashboard user is trusted to that level.
  Hardening hooks: the sidecar enforces a `shells` allowlist and a
  `maxSessions` cap; the server REST/WS layer requires JWT, scopes
  terminals to the opening user (`requireOwned`), and the `Terminal`
  table is an audit trail (open/close timestamps, exit codes).
- **Terminal latency budget**: terminal traffic flows
  browser → server-WS → Redis Streams → sidecar → PTY → sidecar →
  Redis → server → browser-WS. With Upstash (regional) you'll see
  ~50-150 ms RTT per keystroke echo. That's fine for typing commands;
  it is noticeably laggy for full-screen TUIs (`vim`, `htop`,
  `less +F`). If you need that, swap the per-agent `term:out` Redis
  consumer for a direct sidecar→server WebSocket, keep the PTY runner
  unchanged, and only the bridge code in `apps/server/src/modules/terminal`
  has to move. The wire types in `shared-types` already support it.
- **Terminal transcripts are not persisted**: the `Terminal` row stores
  metadata only — never the keystroke/output transcript. Adding one
  would balloon storage fast and risks capturing secrets typed into the
  shell. If you need replay, add a separate, opt-in `TerminalTranscript`
  table and gate it behind `terminal.recordTranscript: true` per sidecar.
- **Terminal output binary safety**: PTYs emit raw bytes (escape
  sequences, control chars, partial UTF-8 across read boundaries). We
  base64-encode `data` in both directions so JSON serialization can't
  corrupt them. The xterm.js side decodes back to bytes via `atob` and
  hands them to `term.write` — do NOT try to be clever and decode as
  UTF-8 strings server-side, you'll mangle multibyte chars at chunk
  boundaries.

## Tech debt / planned

- Per-socket backpressure for `delta` chunks (drop-on-lag).
- Real RBAC and multi-tenant isolation.
- OpenTelemetry traces from web → server → sidecar (we already log structured).
- Pool routing (`agents.{type}.commands` consumer group) for "any agent of
  type X" — the protocol/streams support it; the dashboard doesn't expose it
  yet.
- Pre-commit hooks (ruff/eslint) and a CI workflow.

## When you change something

- **Wire format** → update `packages/shared-types/src/protocol.ts` **and**
  `packages/sidecar/internal/protocol/protocol.go`.
- **Streaming UX** → update `StreamViewer.tsx` and (if you add a new chunk
  kind) every adapter mapper that should emit it.
- **DB schema** → add a Prisma migration, regenerate the client, and update
  the relevant DTO mappers (`AgentRegistryService.toDto`, `SessionService.toDto`,
  `CommandService.toDto`).
- **Architecture** → update this file.
