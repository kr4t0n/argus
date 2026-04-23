import type {
  AgentStatus,
  AgentType,
  AvailableAdapter,
  CommandStatus,
  FSEntry,
  GitStatus,
  ResultChunk,
  SessionStatus,
} from './protocol';

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
