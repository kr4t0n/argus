import type {
  AgentQuota,
  AgentStatus,
  AgentType,
  AvailableAdapter,
  CommandStatus,
  FSEntry,
  GitCommit,
  GitStatus,
  ResultChunk,
  SessionStatus,
} from './protocol';
import type { TokenUsage } from './usage';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'viewer';
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export type MachineStatus = 'online' | 'offline';

/**
 * Snapshot of a host running argus-sidecar. Created from the first
 * MachineRegisterEvent and refreshed on every subsequent (re-)register.
 * Agents are nested children — see `agents` for the lazy-loaded list.
 */
export interface MachineDTO {
  id: string;
  /** User-friendly label, defaults to hostname (`.local` stripped). */
  name: string;
  hostname: string;
  os: string;
  arch: string;
  sidecarVersion: string;
  /** Adapters detected on PATH at sidecar boot. The dashboard uses this
   *  to populate the "create agent" type dropdown. */
  availableAdapters: AvailableAdapter[];
  status: MachineStatus;
  lastSeenAt: string;
  registeredAt: string;
  /** ISO timestamp; null means the machine is visible/unarchived. */
  archivedAt: string | null;
  /** Convenience count for the sidebar; full agent list lives in agentStore. */
  agentCount: number;
  /** User-chosen icon glyph key (e.g. "server-cog"). Null = use the
   *  frontend's default. Set via PATCH /machines/:id/icon — the
   *  server stores it on the machine row so all dashboards see the
   *  same icon for the same host. */
  iconKey: string | null;
}

export interface AgentDTO {
  id: string;
  /** User-friendly label, unique within a machine. */
  name: string;
  type: AgentType;
  machineId: string;
  /** Denormalized for sidebar display; matches Machine.name at render time. */
  machineName: string;
  status: AgentStatus;
  /**
   * Whether this agent's supervisor has a PTY runner attached. Controls
   * whether the dashboard exposes the Terminal pane; the server also
   * rejects terminal-open requests for agents where this is false.
   */
  supportsTerminal: boolean;
  version: string | null;
  workingDir: string | null;
  lastHeartbeatAt: string;
  registeredAt: string;
  /** ISO timestamp; null means the agent is visible/unarchived. */
  archivedAt: string | null;
}

export interface CreateAgentRequest {
  name: string;
  type: AgentType;
  workingDir?: string;
  supportsTerminal?: boolean;
  /** Optional adapter-specific options forwarded to the sidecar. */
  adapter?: Record<string, unknown>;
}

export interface SessionDTO {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  externalId: string | null;
  status: SessionStatus;
  /** ISO timestamp; null means the session is active/unarchived. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandDTO {
  id: string;
  sessionId: string;
  agentId: string;
  kind: 'execute' | 'cancel';
  prompt: string | null;
  status: CommandStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface ResultChunkDTO extends ResultChunk {}

export interface CreateSessionRequest {
  agentId: string;
  title?: string;
  prompt?: string;
}

export interface CreateCommandRequest {
  prompt: string;
  options?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────
// Terminals (interactive PTY)
// ─────────────────────────────────────────────────────────────────────

export type TerminalStatus = 'opening' | 'open' | 'closed' | 'error';

export interface TerminalDTO {
  id: string;
  agentId: string;
  userId: string;
  status: TerminalStatus;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  exitCode: number | null;
  closeReason: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface OpenTerminalRequest {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** WS event payloads (client ⇄ server) */
export interface TerminalInputMessage {
  terminalId: string;
  /** base64 raw bytes (matches the wire protocol). */
  data: string;
}

export interface TerminalResizeMessage {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalOutputMessage {
  terminalId: string;
  seq: number;
  /** base64 raw bytes from the PTY. */
  data: string;
}

export interface TerminalClosedMessage {
  terminalId: string;
  exitCode: number;
  reason?: string;
}

/**
 * REST response for `GET /agents/:id/fs/list`. The controller waits for
 * the sidecar's fs-list-response on the lifecycle stream and surfaces
 * exactly one of `entries` (success) or `error` (sidecar rejected the
 * path, or the agent is offline and the request timed out).
 */
export interface FSListResponse {
  path: string;
  entries: FSEntry[];
  /** Populated when the caller passed `depth > 1`. Keys are paths
   *  relative to the agent's workingDir (empty string = root); each
   *  value is that directory's listing. Lets the dashboard hydrate its
   *  tree cache in one round trip. The entry for the requested `path`
   *  duplicates `entries` so consumers can read from either field. */
  listings?: Record<string, FSEntry[]>;
  /** Present when the agent's workingDir is a git repo. Refreshed on
   *  every listing (the sidecar reads .git/HEAD per call) so any tree
   *  refetch also refreshes the branch indicator in the dashboard. */
  git?: GitStatus;
}

/**
 * REST response for `GET /agents/:id/fs/read`. Discriminated union: the
 * dashboard switches the viewer based on `result.kind`. The error path
 * (path escaped jail, file too large, agent offline, sidecar refused)
 * surfaces as an HTTP error and never reaches this shape.
 */
export type FSReadResult =
  | { kind: 'text'; content: string; size: number }
  | { kind: 'image'; mime: string; base64: string; size: number }
  | { kind: 'binary'; size: number };

/**
 * REST response for `GET /agents/:id/git/log`. Carries both the
 * recent-commits list and the current GitStatus (branch / detached
 * HEAD) so the dashboard's commit panel doesn't have to round-trip a
 * separate fs-list call just to render its header. Empty `commits`
 * with no `error` means the workingDir isn't a git repo, OR is a
 * fresh repo with no commits yet — the panel renders an empty state
 * either way.
 */
export interface GitLogResponse {
  commits: GitCommit[];
  /** Same shape as on FSListResponse — present iff the workingDir is
   *  a git repo. Lets the panel header render the branch / detached
   *  HEAD label without a parallel fs-list call. */
  git?: GitStatus;
}

export interface FSReadResponse {
  path: string;
  result: FSReadResult;
}

// ─────────────────────────────────────────────────────────────────────
// Sidecar version + remote update
// ─────────────────────────────────────────────────────────────────────

/**
 * Latest tag the server resolved from GitHub Releases (cached server-side
 * for ~30 min). `current` is the version this machine's sidecar reported
 * at register time. `updateAvailable` is a convenience: true when both
 * are non-empty and they differ.
 */
export interface SidecarVersionInfo {
  current: string;
  latest: string | null;
  /** When the server last successfully fetched the latest tag (ISO). */
  latestCheckedAt: string | null;
  updateAvailable: boolean;
}

/** 202 ACCEPTED body for POST /machines/:id/sidecar/update. The
 *  dashboard listens for matching sidecar-update-* WS events keyed on
 *  `requestId`; the request returns immediately and the loop closes
 *  when the new sidecar re-registers with `toVersion`. */
export interface SidecarUpdateAccepted {
  requestId: string;
  machineId: string;
  fromVersion: string;
}

/** One row in the bulk update plan. Returned both at acceptance time
 *  (everything `queued` or `skipped`) and via batch-progress updates. */
export interface SidecarUpdatePlanEntry {
  machineId: string;
  machineName: string;
  fromVersion: string;
  status:
    | 'queued'
    | 'in-progress'
    | 'completed'
    | 'failed'
    | 'skipped-offline'
    | 'skipped-already-current';
  toVersion?: string;
  error?: string;
}

/** 202 body for POST /machines/sidecar/update-all. */
export interface SidecarUpdateBatchAccepted {
  batchId: string;
  plan: SidecarUpdatePlanEntry[];
}

// ─────────────────────────────────────────────────────────────────────
// User views
// ─────────────────────────────────────────────────────────────────────

/** One bucket in the activity heatmap — `count` commands the user
 *  sent on this UTC day. `date` is `YYYY-MM-DD`. */
export interface ActivityDay {
  date: string;
  count: number;
}

/** REST response for `GET /me/activity`. Days are dense (zero-days
 *  included) and ordered ascending; the client renders them as a
 *  GitHub-style 7-row × N-column grid. */
export interface UserActivityResponse {
  days: ActivityDay[];
}

/** Token totals bucketed by a rolling time window. `lifetime` is
 *  every command the user owns; `last30Days` / `last7Days` are the
 *  same SUM scoped to `Command.createdAt >= now() - interval`. The
 *  windows are rolling (now-anchored, not calendar-aligned) and each
 *  carries the optional-field contract independently — a window with
 *  no cost-bearing turns omits `costUsd` even when `lifetime` has one,
 *  so recent codex-only activity never sprouts a spurious "$0.00". */
export interface WindowedUsage {
  last7Days: TokenUsage;
  last30Days: TokenUsage;
  lifetime: TokenUsage;
}

/** REST response for `GET /me/usage`. Totals across every session the
 *  user owns, parsed per-adapter on the server using the same
 *  `parseUsage` the dashboard's per-session UsageBadge uses — so the
 *  totals never disagree with what the user sees while looking at any
 *  single session. Bucketed into rolling 7-/30-day windows plus the
 *  all-time lifetime total; the panel toggles between them client-side
 *  off this single payload. */
export interface UserUsageResponse {
  usage: WindowedUsage;
}

/**
 * One row in `UserQuotaResponse`. Carries the freshest per-CLI plan
 * quota the server has across the user's fleet of sidecars, plus the
 * machine that reported it so the dashboard can attribute the data
 * (e.g. "claude.ai login on `kyle-laptop`").
 *
 * `windows` is empty + `error` set when the probe ran but the vendor
 * endpoint refused (401/429/etc); the dashboard surfaces this so users
 * can tell "no auth" from "auth ok but vendor changed the endpoint."
 */
export interface UserQuotaRow {
  type: AgentType;
  source: AgentQuota['source'];
  windows: AgentQuota['windows'];
  error?: string;
  /** ISO 8601 — when the sidecar last successfully probed the endpoint. */
  checkedAt: string;
  /** UUID of the machine whose sidecar produced this report. */
  machineId: string;
  /** Display name of that machine (denormalized so the dashboard doesn't
   *  have to cross-reference the machine list). */
  machineName: string;
}

/**
 * REST response for `GET /me/quota`. One row per agent type the
 * fleet has any data for. Adapter types installed on at least one
 * sidecar but never successfully probed appear with an `error` row;
 * adapter types nobody has ever signed into are simply absent.
 */
export interface UserQuotaResponse {
  quotas: UserQuotaRow[];
}

/** REST response for `GET /me/rules`. `rules` is a free-form text
 *  blob the user wants every CLI agent they spawn to follow. Empty
 *  string means "no rules" — the response always carries a string
 *  so the client doesn't have to disambiguate null vs unset. */
export interface UserRulesResponse {
  rules: string;
}

/** Request body for `PUT /me/rules`. Server enforces an upper bound
 *  (USER_RULES_MAX_BYTES) so a runaway paste can't blow up the
 *  database row. */
export interface UpdateUserRulesRequest {
  rules: string;
}

/** Hard cap for stored rules text. 32 KB is generous compared to a
 *  typical AGENTS.md / CLAUDE.md / .cursorrules file (a few KB at
 *  most) while staying well under any realistic Postgres TEXT limit. */
export const USER_RULES_MAX_BYTES = 32_768;

/** REST response for `GET /me/project-notes?machineId=…&workingDir=…`.
 *  `notes` is a free-form scratchpad the user keeps for a project — a
 *  project being the `(machineId, workingDir)` pair every session in
 *  that directory shares. Empty string means "no notes yet"; the
 *  response always carries a string so the client never has to
 *  disambiguate null vs unset. */
export interface ProjectNotesResponse {
  notes: string;
}

/** Request body for `PUT /me/project-notes`. The project the note
 *  belongs to is identified by the `machineId` / `workingDir` query
 *  params; the body carries only the text. Server enforces an upper
 *  bound (PROJECT_NOTES_MAX_BYTES). */
export interface UpdateProjectNotesRequest {
  notes: string;
}

/** Hard cap for stored project-notes text. Mirrors USER_RULES_MAX_BYTES
 *  — notes are a freeform scratchpad, 32 KB is plenty while staying
 *  well under any realistic Postgres TEXT limit. */
export const PROJECT_NOTES_MAX_BYTES = 32_768;

/** REST response for `GET /me/extensions`. Which opt-in extensions the
 *  user has enabled — an account-level preference (synced across
 *  browsers/devices), distinct from device-local UI state like theme.
 *  One boolean per extension; absent extensions read as `false`. As
 *  extensions are added this gains fields. Stored server-side as a
 *  JSON map so new extensions need no migration. */
export interface UserExtensionsResponse {
  /** Notes extension — adds a per-project Note tab to the session pane. */
  notes: boolean;
  /** Progress extension — adds a per-project Progress tab that lists
   *  live background tasks reported by `argus-bg` running in the
   *  agent's shell. */
  progress: boolean;
}

/** Request body for `PUT /me/extensions`. The client sends the full
 *  set of known extension flags; the server replaces its stored map. */
export interface UpdateUserExtensionsRequest {
  notes: boolean;
  progress: boolean;
}

/** REST response for `GET /machines/:machineId/background-tasks`. One
 *  row per active-or-recently-ended background task in the given
 *  project, keyed by taskId. `endedAt` set ⇒ task has finished and the
 *  server is keeping it briefly so late-joining dashboards still see
 *  the final state. */
export interface BackgroundTaskDTO {
  taskId: string;
  machineId: string;
  workingDir: string;
  agentId: string;
  label?: string;
  cmd?: string[];
  /** Latest progress reading, if any. Omitted when the task started
   *  but hasn't yet emitted a progress frame (tqdm hasn't fired its
   *  first update). */
  current?: number;
  total?: number;
  percent?: number;
  etaSeconds?: number;
  rate?: number;
  unit?: string;
  desc?: string;
  /** ms epoch — when the task's `start` event was observed. */
  startedAt: number;
  /** Latest event timestamp (start OR most recent progress OR end). */
  ts: number;
  /** Set only after the task ends. */
  endedAt?: number;
  exitCode?: number;
  status?: 'done' | 'failed';
}

/** REST response for `GET /machines/:machineId/background-tasks`. */
export interface BackgroundTasksResponse {
  tasks: BackgroundTaskDTO[];
}
