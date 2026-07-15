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

### Phase 2 — re-key read paths ✅ IMPLEMENTED (branch refactor/agent-to-runners)

Shipped: fs/git wire requests carry `workingDir` + representative
`agentId` (old sidecars route by agent, new sidecars serve the workdir
after allowlist validation — `daemon.workdirAllowed`, supervisors'
specs for now, sync-projects in Phase 3); `/projects/:id/fs|git`
routes; catalogs stored machine×CLI (`MachineCliCatalog`, backfilled
from Agent.modelCatalog) with `/machines/:id/models?cliType=` and the
picker re-keyed — cold-start hole fixed; watcher nudges carry
workingDir and fan out to the existing project room (legacy agent room
kept); sidebar groups sessions by `session.projectId` with agent-join
fallback. Deferred to a follow-up: FileTree / GitLogPanel /
fileTabsStore switching to the project routes — they keep using the
agent routes, which stay fully functional through Phase 3 (only
heartbeats/streams change there); must land before Phase 4.

Original scope for reference:

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

### Phase 3 — sidecar runners + stream consolidation ✅ IMPLEMENTED (branch refactor/agent-to-runners)

Verified end-to-end with the real sidecar binary (built as 0.3.0-test)
+ fake-claude against a local stack: machine-register → project-first
session create → sync-projects reconcile → prompt dispatched on
machine:{id}:cli:claude-code:cmd → 17 chunks ingested from the runner
result stream → second turn resumed via the stable externalId; fs RPC
served workdir-addressed in ~12ms; live model probe answered; ZERO
per-agent heartbeat/register events on lifecycle; no per-agent streams
created. Found-and-fixed during verification: the server's three
blocking consumer loops (lifecycle, results, background) shared ONE
ioredis connection, serializing behind each other's 5s BLOCK — masked
for years by heartbeat chatter, exposed the moment the lifecycle
stream went quiet. Each loop now owns a dedicated connection
(redis.service.ts).

Deploy order (STRICT): server first, then sidecars. A ≥0.3.0 sidecar
against a pre-Phase-3 server has no command path. isRunnerSidecar()
gates on MAJOR.MINOR ≥ 0.3 (prerelease-tolerant).

Locked design decisions (as implemented):

- **Clean cut, server-leading.** Sidecar ≥0.3.x drops supervisors
  entirely: runners per installed CLI, no per-agent heartbeats, new
  streams. It REQUIRES a Phase-3 server (deploy order: server first,
  then sidecars self-update — Kyle's normal order). The server keeps
  full legacy support for old sidecars, gated on `Machine.sidecarVersion`
  (semver ≥ 0.3.0 ⇒ new-style). Old-server + new-sidecar is unsupported.
- **Streams**: `machine:{id}:cli:{type}:cmd` / `:result`, MAXLEN mirrors
  the per-agent caps (200/500) in both streamMaxLen helpers. Wire
  `Command` gains `workingDir` (from Session, pinned at create) —
  adapters take Dir per command; `CloneSession` gains a workdir arg.
- **Dispatch** (`command.service.ts`): session → projectId/cliType →
  machine; new-style ⇒ machine:cli stream + machine-level online gate;
  legacy ⇒ agent stream as today. Result-ingestor consumes new-style
  machines' (machine × availableAdapters) streams + old machines'
  agent streams; ingest itself is unchanged (chunks carry
  commandId/sessionId).
- **Agent rows become routing records** on new-style machines: they
  inherit machine liveness (machine-heartbeat handler bumps their
  status/lastHeartbeatAt so sweepStale never false-flags them); busy is
  already session-derived in the UI. Rows keep serving iOS + legacy
  reads until Phase 4.
- **Control plane**: new sidecars get `sync-projects` (full workdir
  allowlist, idempotent, re-sent on every register and on any
  vivify/create/destroy) instead of create/destroy/sync-agents. The
  allowlist feeds `workdirAllowed` (Phase 2) and the watcher registry.
- **Watchers**: refcounted per-workdir registry (fs/git/progress) built
  from the allowlist; events carry workingDir (agentId empty) — the
  server's project-room fanout (Phase 2) already routes them.
- **Terminal**: server sends cwd explicitly in TerminalOpen (from the
  agent row / project); sidecar drops its Lookup(agentID) dependency.
  Capability check stays server-side.
- **Catalog push**: once per runner spawn instead of per supervisor.

Original scope for reference:

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

### Phase 4 — retire Agent ✅ IMPLEMENTED (branch refactor/agent-to-runners)

DONE: server drops the Agent as a runtime entity (agentId → nullable
attribution; sessions route by projectId→machine + cliType→runner);
agent-registry + agent-addressed fs/git/models/terminal REST deleted;
per-agent lifecycle handling gone. Web off agent identity (no /agents
fetch; sidebar groups by projectId; MachinePanel shows projects). iOS
Stage C drops agent client methods; MachineView shows projects.
Verified e2e (agentless session create/dispatch/resume/fork/terminal;
lifecycle stream = machine-heartbeats only) + web/iOS builds green.

Deploy: server+web image first (fleet already ≥0.3); iOS ships on its
App Store cadence (its Stage A tolerance means it survives either way).
Follow-ups (non-blocking cosmetic): remove the fs.service dead agent
methods, web agentStore + CreateAgentPopover agent branch + archive
cascade agent calls, iOS FleetStore.agents + agent WS cases. Sweep the
~41 leftover agent:{id}:* Redis streams once (Kyle-approved, data-safe).

### Phase 5 — sweep the vestigial agentId ✅ IMPLEMENTED (branch refactor/agent-to-runners)

Gate cleared by a prod check: `SELECT count(*) FROM "Session" WHERE
"projectId" IS NULL` = 0, so no session still needs the resolveRouting
agent fallback. DONE:
- DB migration `9_phase5_drop_agent_columns` DROPS `Session.agentId` /
  `Command.agentId` / `Terminal.agentId` (FKs + indexes + columns). Named
  `9_…` so it sorts lexicographically AFTER `6/7/8_backfill_command_usage`
  (which read `Command.agentId`) — a `2026…` timestamp name would sort
  before them and break a fresh `migrate deploy`. Validated: full fresh
  replay + `migrate diff` drift-free against schema.prisma.
- Server: resolveRouting is projectId-only (agent fallback gone); DTO
  mappers drop agentId; fork/dispatch stop writing/sending it;
  computeCommandUsage uses `session.cliType` only; terminal
  markAllForMachineClosed filters by `machineId` (was an Agent join).
- shared-types: `agentId` removed from SessionDTO / CommandDTO /
  TerminalDTO / CreateSessionRequest and wire `Command`; dead
  `streamKeys.command/result` (per-agent) + `consumerGroups.sidecar`
  removed.
- Web: resolveProjectRef is projectId-only; SidebarRail re-keyed to
  projectId (fixes a latent empty-grouping bug); queueDrainer reachability
  is machine-level; dead `!asSession`/`api.createAgent` branch removed.
- The `Agent` TABLE is intentionally KEPT (feeds agentCount + syncProjects
  backfill + representative attribution — all keyed by machineId, not the
  dropped FKs). iOS untouched (its Swift models are independent; the server
  simply stops sending agentId; `decodeIfPresent` → nil).

Still deferred (needs its own change): full Agent-table deletion (requires
`Machine.agentCount` removed from web + iOS → iOS macOS build); the ~41
leftover `agent:{id}:*` Redis streams (prod mutation, data-safe).

Original gate (all cleared):

- [x] Whole fleet runs sidecar ≥0.3.x (Kyle confirms after real-life
      testing of rc.2+; `SELECT "sidecarVersion" FROM "Machine"`)
- [ ] Phases 1–3 soak in prod without regressions (fs panel, turn
      dispatch/streaming, archive flows, quota, terminals)
- [x] Web FileTree / GitLogPanel / fileTabsStore switched to project
      routes + project rooms (ProjectRef in lib/projects.ts; legacy
      agent-room shim kept for the mixed-fleet window; queue drainer
      reachability is machine-level; agent fs/git api methods deleted)
- [x] iOS Stages A+B IMPLEMENTED (commit 8e6fae7) — macOS CI green
      (ArgusKit swift build+test AND the app's xcodebuild Simulator
      build). Stage A = the DTO relax that MUST be installed on devices
      BEFORE the Phase-4 server nulls agentId; App Store propagation is
      now the long pole of the gate, so cut a build early.
- [ ] Kyle: build + ship the iOS app from a macOS window, confirm
      on-device (sessions list, transcripts, project-first create,
      Files/Commits live refresh on a ≥0.3 machine, model picker,
      queued prompts).
- [x] Terminals are (machine, cwd)-addressed — the last agent-addressed
      surface. `POST|GET /projects/:id/terminals`; Terminal rows carry
      machineId (routing) + projectId, agentId is attribution-only and
      SetNull; the keystroke hot path no longer joins Agent. Capability
      moved to Project.supportsTerminal (migration inherited it from
      terminal-capable agents). Both clients prefer the project route,
      falling back to the agent route only for workdir-less sessions.
      Legacy machines (<0.3 sidecar) still need a terminal-capable agent
      under the project — the server says so explicitly rather than
      letting the sidecar reject silently.
- [ ] KNOWN BUG until iOS Stage B: iOS Files/Commits live refresh is
      already broken against ≥0.3 sidecars TODAY (it joins the agent
      room and filters on agentId; runner watcher events carry empty
      agentId and fan out to the project room only). Manual refresh
      still works; web is unaffected.

iOS migration plan (from the code inventory, apps/ios):
- Stage A (additive, safe against current server): relax agentId to
  optional on SessionDTO/CommandDTO/TerminalDTO/BackgroundTaskDTO/
  ModelCatalogResponse and the fs/git WS payloads (+machineId/
  workingDir fields); add SessionDTO.projectId/cliType; ProjectDTO
  gains the promoted-row fields; CreateSessionRequest gains the
  project shape; harden AppModel.refreshAll so a listAgents failure
  can't abort sessions/machines/projects hydration (today one 404
  = infinite sidebar spinner).
- Stage B: AppModel.createSession drops its client-side vivify for one
  project-first POST; ProjectRef resolver ported from the web;
  FileBrowser/Commits/FilePreview/InspectorPane re-keyed to project
  routes + project rooms (fixes the live-refresh bug); model picker →
  /machines/:id/models?cliType=; agentType consumers → session.cliType
  (VM cache, Live Activities, transcript parsers, icons); sidebar
  groups by session.projectId with fleet.projects anchors (needs a new
  deliberate sort rule — agentSortsBefore dies); queue gate →
  machine-level.
- Stage C (with Phase-4 removals): delete the 13 agent-addressed
  client methods (getAgent/archive/unarchive/listTerminals have zero
  call sites already), MachineView agent roster + NewAgentSheet,
  FleetStore.agents + agent WS cases, fixtures/tests/capture script
  vocabulary.

Removal checklist when the gate clears: drop the auto-vivify +
create/destroy-agent control path; Session.agentId / Command.agentId /
Terminal.agentId → nullable attribution columns (migration; history
keeps rendering); delete agent-registry REST + agent-addressed
fs/git/models routes + legacy request shapes; retire per-agent
register/heartbeat/deregister handling and the per-agent sweepStale
arm; sweep leftover agent:{id}:* streams; drop Agent.modelCatalog
columns; delete dead consumerGroups.sidecar; AGENTS.md/README to
runner/project vocabulary.

Original sketch:

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
