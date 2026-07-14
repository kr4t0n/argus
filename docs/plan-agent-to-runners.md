# Plan: retire per-agent resources — Runners (machine × CLI) + first-class Projects

Status: draft for discussion · 2026-07-13
Owner: kyle
Prereq: Phase 0 (lifecycle consumer fix) ships independently, before any of this.

## 1. Motivation

An "agent" today is one CLI × one workingDir pair, and every per-agent resource
scales with that product: with M machines, C CLIs, and P projects per machine,
we carry O(M·C·P) heartbeats, Redis streams, consumer groups, goroutines, and
fsnotify watchers — while the *bounded* dimensions are M and C (a machine has
2–5 CLIs installed, forever). P is the dimension users grow without limit.

This is no longer theoretical. Measured on prod (2026-07-13):

- `agent:lifecycle` inflow ≈ 2.4 events/s (~12 agents + 4 machines × 1
  heartbeat / 5 s), vs consumer throughput ≈ 2 events/s (one Prisma round
  trip + one 144 ms XACK per entry, sequential).
- Backlog (group lag) grew unboundedly; at one snapshot lag (506) exceeded
  stream length (504) — MAXLEN was trimming entries that were never
  delivered. fs-list/fs-read/git-log responses ride this stream, so the
  dashboard showed "agent did not respond — the machine may be offline"
  against perfectly healthy sidecars, and `sweepStale` flapped live machines
  offline.

Phase 0 fixes the throughput arithmetic; this refactor removes the linearity
so the arithmetic never degrades again. It also finishes a migration the
codebase already started: since v0.2.0 the sidebar is project → sessions,
agents are auto-vivified with random names ("the agent layer becomes
implementation detail" — commit a162f96), and quota, background tasks,
terminals, project notes, and the Go command reader are *already* keyed by
machine, machine × CLI, or machine × workdir.

## 2. Target architecture

The Agent entity is doing three unrelated jobs. Split it:

| New concept | Key | Owns |
|---|---|---|
| **Runner** | (machineId, cliType) | cmd/result streams, adapter instance, model catalog, `supportsTerminal`-style capability flags. Presence = machine heartbeat + `availableAdapters`; **no per-runner heartbeat**. |
| **Project** (promoted) | (machineId, workingDir) | fs/git jail root, refcounted fs/git/progress watchers, WS rooms for `fs:changed` / `git:changed`, icons/notes (already there). |
| **Session** | id (existing) | + `projectId`, + `cliType`. workingDir is **pinned at first prompt** and sent on every subsequent execute/clone (see §4.1). `busy` is derived from command lifecycle server-side, not heartbeated. |

Post-refactor steady-state Redis load: heartbeats O(M), streams O(M·C),
result-ingestor stream list static per machine (no more 5 s Agent-table
poll). Adding the 50th project on a machine adds a DB row and nothing else.

## 3. Current-state inventory (what's already migrated vs remaining)

Already at target keying (no work needed):

- `MachineAgentQuota` — `@@unique([machineId, agentType, fingerprint])`.
- Background tasks — `(machineId, workingDir, taskId)`; protocol comment says
  agentId is attribution-only (`protocol.ts:430-434`).
- Terminals — sidecar link + runner keyed by machineId (`terminal.service.ts`
  HotMeta comment); agentId only supplies default cwd + capability flag.
  `TerminalOpen` already carries an optional `Cwd` override.
- Sidecar command reader — one machine-wide XREADGROUP under
  `sidecar-cmd-{machineId}` (`protocol.go:802-812`). The TS
  `consumerGroups.sidecar(agentId)` (`protocol.ts:1159`) is dead code / drift.
- Web sidebar — project-first since v0.2.0; `Project` row exists
  (`schema.prisma:149`, `@@unique([machineId, workingDir])`) as the anchor;
  `projectStore.ts:14-19` explicitly plans "promote the rest to the Prisma
  table when the next step lands."

Remaining per-agent surfaces:

- Prisma: `Session.agentId`, `Command.agentId`, `Terminal.agentId` FKs;
  Session/Command have no workingDir of their own.
- Redis: `agent:{id}:cmd` / `agent:{id}:result` streams + per-stream `server`
  groups; per-agent heartbeat every 5 s.
- Server: command dispatch resolves session → agent → stream + offline gate;
  fs/git/models RPC addressed by agentId (jail resolved sidecar-side from the
  agent spec); result-ingestor rebuilds its stream list from the Agent table
  every 5 s; gateway rooms `agent:{id}`; lifecycle handlers + `sweepStale`
  maintain per-agent status.
- Sidecar: `supervisors map[agentID]`, ~6 goroutines + 3 workdir watchers per
  supervisor (duplicated when two agents share a workdir), adapter
  `--version`/Ping probe + model-catalog push per agent, on-disk cache of
  agent specs, per-agent heartbeat loop.
- Clients: web + iOS both send `CreateSessionRequest{agentId}` (18 Swift
  files reference agentId).

## 4. Hard constraints discovered (design around these)

### 4.1 CLI resume state is keyed by cwd on disk

- claude-code: `~/.claude/projects/<slug(workingDir)>/<sessionId>.jsonl`;
  `--resume` resolves against the project dir derived from process cwd.
- cursor-cli: `~/.cursor/chats/<md5(workspace path)>/<chatId>/store.db`.
- codex: date-bucketed globally, workdir-independent (the easy one).

⇒ workingDir is **per-session** state, not per-command. Pin it at session
creation (first prompt), store on Session, send with every execute / cancel /
clone. Forking a session into a different workdir stays impossible for
claude/cursor — the UI must not offer it.

### 4.2 `busy` semantics

Today `busy` comes from the supervisor's atomic in-flight counter, heartbeated
per agent. A runner-level counter would conflate all workdirs sharing a CLI.
Replacement: the server derives busy per session/project from command
lifecycle (it already writes `Command.status` on dispatch and finalize —
no new wire events needed). The dispatch-time offline gate
(`command.service.ts:53-55`) becomes a machine-level check.

### 4.3 fs jail trust model

Today the sidecar resolves the jail root from its own cached agent spec; the
server can't request paths outside a known workdir. With workdir-as-parameter
the sidecar MUST validate the requested workdir against its known-projects
allowlist (it already persists workdirs in `~/.config/argus/sidecar.json`)
before serving fs-list/fs-read/git-log. Reject unknown workdirs; the server
registers new projects through an explicit control command, not implicitly
via an fs request.

### 4.4 Mixed-fleet rollout

Sidecars self-update on a lag; old and new must coexist against one server.
Every phase below is server-leading and backward compatible: the server keeps
consuming per-agent heartbeats and per-agent result streams until the last
sidecar is upgraded (it already handles pre-notify sidecars this way).

## 5. Phases

Each phase ships independently and is individually revertable.

### Phase 0 — lifecycle consumer fix ✅ SHIPPED (dev @ 4a7b8e7, verified in prod)

In `machine.service.ts` consume loop: batch XACKs (one variadic call per
stream per batch), handle RPC responses (`fs-*-response`, `git-log-response`,
`model-catalog-response`, `sidecar-update-*`) before DB-heavy entries within
each batch, coalesce heartbeats per batch (newest per agent / machine) and
group writes into `updateMany`, and fix the NOGROUP self-heal to re-ensure
the group on BOTH `agent:lifecycle` and `agent:notify`. Also mirror the
NOGROUP fix anywhere a multi-stream XREADGROUP self-heals. Coalescing becomes
mostly moot after Phase 3 but is correct and cheap insurance meanwhile.

### Phase 1 — promote Project; Session absorbs workdir + cliType ✅ IMPLEMENTED (branch refactor/runners-phase1-projects)

- Schema: `Session.projectId` (FK → Project, SetNull) + `Session.cliType`;
  migration `20260713164250_session_project_clitype` backfills both from
  `session.agent.{machineId,workingDir,type}` and reuses icon-path Project
  rows via ON CONFLICT. Deviation from the original sketch: sessions on
  workdir-less agents keep `projectId` NULL (the sidebar already renders a
  synthetic per-machine bucket client-side) instead of a synthetic Project
  row — one less sentinel to special-case. `Session.agentId` stays
  populated and authoritative for dispatch — this phase is additive only.
- Server: session create accepts `{machineId, workingDir, cliType,
  supportsTerminal}` (not `{projectId}` — the client often doesn't have a
  row id yet; the server upserts the Project row from the pair) and
  auto-vivifies the agent internally (logic moved out of
  `CreateAgentPopover.tsx`); the vivified AgentDTO rides the response so
  the client seeds its store without racing `agent:upsert`. Legacy
  `{agentId}` accepted for iOS — and it ALSO pins projectId/cliType.
  Forks copy `projectId`/`cliType` from the source session.
- Web: `CreateAgentPopover` asSession path posts the new shape.
- Phase 1b ✅ IMPLEMENTED: placeholders promoted to server rows — Project
  gains `name`, `supportsTerminal`, `archivedAt`, `archiveSnapshot`
  (migration `20260714031024_project_placeholder_promotion`); POST
  /projects + rename/archive/unarchive endpoints; the archive *cascade*
  deliberately stays client-driven via existing per-item REST — the row
  only persists the outcome + restore snapshot, so no new server-side
  cascade semantics were introduced. Web `projectStore` is hydrated from
  GET /projects (localStorage is a paint-instantly cache), and
  `migrateLocalProjects.ts` one-shot-pushes pre-promotion local rows.
- Docs: AGENTS.md `project/` module + sidebar sections updated.

### Phase 2 — re-key read paths: fs/git/models RPC + WS rooms (server + web + sidecar-tolerant)

- fs/git RPC: routes gain project addressing
  (`/projects/:id/fs/*`, `/projects/:id/git/log`); the wire request to
  `machine:{id}:control` carries `workingDir` explicitly; new sidecars serve
  from the parameter after allowlist check (§4.3), old sidecars keep serving
  agentId-addressed requests — server picks per sidecar version, or sends
  both fields (workingDir + a representative agentId) during the window.
- Models catalog: store per (machineId, cliType) — new table or move to
  keying like MachineAgentQuota; `list-models` request carries cliType. Fixes
  the cold-start hole where a project's first session of a type has no
  catalog.
- Gateway: rooms become `project:{projectId}` for fs/git nudges; keep
  emitting to legacy `agent:{id}` rooms during the window. `fs-changed`
  events already carry path; sidecar adds workingDir (most events carry it
  already).

### Phase 3 — sidecar runners + stream consolidation (the wire change)

- Sidecar: replace `supervisors map[agentID]` with runners per cliType;
  refcounted watcher registry keyed by workdir (start on first
  session/subscription touching a workdir, stop on last) — kills today's
  duplicate inotify watches and doubled `fs-changed`/`background-task-*`
  events; one `--version`/Ping/catalog probe per CLI instead of per agent.
- Streams: `machine:{id}:cli:{type}:cmd` / `:result` (MAXLEN as today's
  per-agent caps × small factor). Wire `Command` gains `workingDir` (from
  Session). Result chunks already carry commandId/sessionId — ingestor
  unaffected beyond stream names.
- Heartbeats: per-agent heartbeat retired; machine heartbeat (already
  carries quotas) is the only liveness signal. Server `sweepStale` drops the
  per-agent arm; session/project busy comes from §4.2.
- Compat: server consumes BOTH old per-agent and new per-runner result
  streams keyed off `Machine.sidecarVersion`; `sync-agents` continues for old
  sidecars, new sidecars get `sync-projects` (the workdir allowlist).
- Cleanup of drift folded in: delete dead TS `consumerGroups.sidecar`.

### Phase 4 — retire Agent

- iOS migrates to `{projectId, cliType}` session creation (needs a macOS
  build window per the iOS constraint).
- Drop the dispatch path through Agent; `Session.agentId` /
  `Command.agentId` become nullable attribution columns (history keeps
  rendering); stop creating Agent rows; archive UI for agents removed;
  `agent:{id}:*` stream deletion sweep for destroyed/idle remnants.
- AGENTS.md + README updated to the runner/project vocabulary.

## 6. Risks & mitigations

- **Resume breakage if workdir drifts** (renamed/moved project dir): resume
  already breaks today in that case; surface a clear error. Mitigation: keep
  the pinned workdir visible in session info.
- **Busy indicator regression** (§4.2): implement + verify in Phase 1 UI
  (derived from Command.status) *before* Phase 3 removes the heartbeat that
  currently feeds it.
- **Security regression on fs RPC** (§4.3): allowlist check lands in the same
  sidecar release that accepts workdir-as-parameter; never ship a sidecar
  that trusts the parameter unconditionally.
- **Mixed fleet** (§4.4): every phase server-leading; feature-gate by
  `Machine.sidecarVersion`; the notify-split rollout is the template.
- **MAXLEN byte budget** (30 MB Redis): consolidating result streams per
  machine×CLI concentrates entries; revisit caps (count ≠ bytes — see
  AGENTS.md gotcha) and keep fat fs responses on the self-cleaning lifecycle
  stream as today.
- **Duplicate agents today** (`@@unique([machineId, name])` does NOT prevent
  two agents on one CLI×workdir): Phase 1 backfill must merge their sessions
  into one (project, cliType) bucket deterministically.

## 7. Explicitly out of scope

- Multi-replica server / horizontal consumer scaling.
- Moving RPC responses off `agent:lifecycle` (Phase 0 makes it a non-issue;
  revisit only if response latency matters again).
- Any change to result chunk persistence or session history rendering.
