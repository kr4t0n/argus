/**
 * Wire protocol shared between the server and every Go sidecar.
 *
 * The Go side keeps equivalent structs hand-mirrored in
 * `packages/sidecar/internal/protocol`. Keep field names in sync.
 */

export const BUILT_IN_AGENT_TYPES = ['claude-code', 'codex', 'cursor-cli'] as const;
export type BuiltInAgentType = (typeof BUILT_IN_AGENT_TYPES)[number];

// Open string: custom adapters can register their own type name.
export type AgentType = BuiltInAgentType | (string & {});

export type AgentStatus = 'online' | 'offline' | 'busy' | 'error';

export type SessionStatus = 'active' | 'idle' | 'done' | 'failed';

export type CommandStatus =
  | 'pending'
  | 'sent'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ResultKind =
  | 'delta' // incremental text fragment (typewriter)
  | 'stdout'
  | 'stderr'
  | 'tool' // tool invocation (grep, read, bash, ...)
  | 'progress' // dim status line
  | 'final' // end of a turn
  | 'error';

/**
 * Per-agent register event, emitted by an agent supervisor inside the
 * machine daemon when it (re-)spawns. The server treats this as a
 * status nudge — the Agent row already exists in Postgres because it
 * was created by the dashboard via POST /machines/:id/agents.
 */
export interface RegisterEvent {
  kind: 'register';
  id: string;
  machineId: string;
  type: AgentType;
  /**
   * Whether the supervisor has a PTY runner attached. Controls whether
   * the dashboard exposes the Terminal pane and whether the server
   * accepts terminal-open requests targeting this agent.
   */
  supportsTerminal: boolean;
  version: string;
  /** Working directory the wrapped CLI is launched in. Empty means inherited. */
  workingDir?: string;
  ts: number;
}

/** Sidecar → server, every N seconds */
export interface HeartbeatEvent {
  kind: 'heartbeat';
  id: string;
  status: AgentStatus;
  ts: number;
}

/** Sidecar → server, on graceful shutdown */
export interface DeregisterEvent {
  kind: 'deregister';
  id: string;
  ts: number;
}

export type LifecycleEvent = RegisterEvent | HeartbeatEvent | DeregisterEvent;

// ─────────────────────────────────────────────────────────────────────
// Machine lifecycle (sidecar daemon ⇄ server)
//
// Each host runs one argus-sidecar process, which self-identifies as a
// `Machine` on the same `agent:lifecycle` stream that agents use. We
// piggy-back the same stream because:
//   - The server already runs one consumer there (single sweep loop).
//   - Machine and agent registrations are causally related (an agent
//     can only register after the server knows about its machine), so
//     ordering matters.
// Events are discriminated by `kind`.
// ─────────────────────────────────────────────────────────────────────

/**
 * One adapter the sidecar found on PATH at boot. Surfaced verbatim in
 * `MachineDTO.availableAdapters` so the dashboard can populate the
 * adapter dropdown in the "create agent" popover with installed CLIs
 * only (don't show "Claude Code" if `claude` isn't on this box).
 */
export interface AvailableAdapter {
  type: AgentType;
  binary: string;
  /** Empty when `<binary> --version` couldn't be parsed; the adapter
   *  is still usable, the dashboard just won't render a version pill. */
  version: string;
}

export interface MachineRegisterEvent {
  kind: 'machine-register';
  machineId: string;
  /** User-friendly name; defaults to hostname (`.local` stripped). */
  name: string;
  hostname: string;
  os: string;   // darwin | linux
  arch: string; // amd64 | arm64
  sidecarVersion: string;
  availableAdapters: AvailableAdapter[];
  ts: number;
}

export interface MachineHeartbeatEvent {
  kind: 'machine-heartbeat';
  machineId: string;
  ts: number;
}

export type MachineLifecycleEvent =
  | MachineRegisterEvent
  | MachineHeartbeatEvent;

// ─────────────────────────────────────────────────────────────────────
// Machine control plane (server → sidecar)
//
// Per-machine stream `machine:<machineId>:control`. The server publishes
// CreateAgent / DestroyAgent commands when a dashboard user mutates the
// machine's agent set, plus a SyncAgents reconcile broadcast on every
// (re)connect so a sidecar that missed events while offline catches up
// without operator intervention.
// ─────────────────────────────────────────────────────────────────────

/** Embedded inside Create / Sync. Mirrors what the sidecar caches. */
export interface AgentSpec {
  agentId: string;
  name: string;
  type: AgentType;
  workingDir?: string;
  supportsTerminal: boolean;
  /** Optional adapter-specific overrides (e.g. binary path, extraArgs).
   *  Sidecar passes these straight to the adapter factory. */
  adapter?: Record<string, unknown>;
}

export interface CreateAgentCommand {
  kind: 'create-agent';
  agent: AgentSpec;
  ts: number;
}

export interface DestroyAgentCommand {
  kind: 'destroy-agent';
  agentId: string;
  ts: number;
}

/** Full canonical list — sidecar reconciles its supervisor set against
 *  this and stops/starts deltas. Sent on every (re)connect. */
export interface SyncAgentsCommand {
  kind: 'sync-agents';
  agents: AgentSpec[];
  ts: number;
}

// ─────────────────────────────────────────────────────────────────────
// Filesystem browsing (right-pane file tree)
//
// The dashboard asks a sidecar to list an agent's working directory so
// it can render a lazy-expanding tree next to the session. Requests
// ride the existing per-machine control stream (one new `kind`), and
// responses (plus unsolicited fsnotify change notifications) come back
// on the shared `agent:lifecycle` stream — same ingress point the
// server already consumes for machine + agent events.
//
// Paths are ALWAYS relative to the agent's workingDir. The sidecar
// jails every resolved path to that root (rejects absolute paths, `..`
// escapes, and symlink chases); the server/dashboard don't need to
// independently validate. Empty string or "." means the root.
// ─────────────────────────────────────────────────────────────────────

export interface FSEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  /** Unix millis. */
  mtime: number;
  /** Only meaningful when `showAll` was true — lets the UI render
   *  ignored entries in a dimmer style while still showing them. */
  gitignored?: boolean;
}

/**
 * Snapshot of the workingDir's git HEAD as observed by the sidecar.
 * Carried on every FSListResponseEvent so the dashboard can flip the
 * branch badge as soon as the next listing comes back — pure-checkout
 * scenarios (no file content changes) are the only miss-case and they
 * are vanishingly rare.
 *
 * `branch` is null in detached-HEAD states (rebase, cherry-pick,
 * `git checkout <sha>`); `head` is then the short SHA the working tree
 * is parked at.
 */
export interface GitStatus {
  branch: string | null;
  head: string;
  detached: boolean;
}

export interface FSListRequestCommand {
  kind: 'fs-list';
  requestId: string;
  agentId: string;
  path: string;
  showAll: boolean;
  /** How many directory levels to include in the response, counting the
   *  requested path as level 1. Omitted / 0 / 1 means only the requested
   *  path (the historical behavior). >1 asks the sidecar to BFS into
   *  non-ignored subdirectories and return every level's listing in
   *  `listings`, so the dashboard can hydrate its cache in one round
   *  trip and expand folders instantly. The sidecar caps the total
   *  number of entries returned to avoid pathological payloads. */
  depth?: number;
  ts: number;
}

/**
 * Read one file's contents. Path is jailed to the agent's workingDir
 * (sidecar enforces) and capped at FS_READ_MAX_BYTES — over the cap is
 * returned as `result: 'error'` with a "file too large" message rather
 * than truncating, since a partial highlight is misleading. Binary
 * detection happens in the sidecar (extension allowlist for text /
 * image, magic-byte sniff otherwise).
 */
export interface FSReadRequestCommand {
  kind: 'fs-read';
  requestId: string;
  agentId: string;
  path: string;
  ts: number;
}

/** Hard cap (in bytes) the dashboard advertises and the sidecar enforces.
 *  Same number for text and image — over the cap, the sidecar returns
 *  an error rather than truncating. */
export const FS_READ_MAX_BYTES = 1_048_576;

// ─────────────────────────────────────────────────────────────────────
// Remote sidecar update (server → sidecar)
//
// The dashboard exposes an "Update sidecar" action per machine and a
// fleet-wide "Update all sidecars" button. Both publish this command on
// the per-machine control stream. The sidecar reuses the same updater
// `argus-sidecar update` runs locally (download → sha256-verify → swap
// binary) and then restarts itself; the restart strategy depends on
// how the sidecar is being supervised (foreground TTY, background mode
// from `argus-sidecar start`, or systemd/launchd).
//
// Progress is reported back on the agent:lifecycle stream as a small
// state machine: started → downloaded → (process exit + new register
// with the new sidecarVersion). Failures terminate at `-failed`.
// `requestId` correlates a started/downloaded/failed triple back to
// the originating API call so the dashboard can match a progress
// toast to a specific click.
// ─────────────────────────────────────────────────────────────────────

export interface UpdateSidecarCommand {
  kind: 'update-sidecar';
  requestId: string;
  ts: number;
}

export type MachineControlCommand =
  | CreateAgentCommand
  | DestroyAgentCommand
  | SyncAgentsCommand
  | FSListRequestCommand
  | FSReadRequestCommand
  | UpdateSidecarCommand;

export interface FSListResponseEvent {
  kind: 'fs-list-response';
  machineId: string;
  agentId: string;
  requestId: string;
  path: string;
  entries?: FSEntry[];
  /** Populated when the request asked for `depth > 1`. Keys are paths
   *  relative to the agent's workingDir (empty string = root), values
   *  are that directory's listing. Always includes an entry for the
   *  requested `path` when present; duplicates what's in `entries` so
   *  clients can consume either field uniformly. */
  listings?: Record<string, FSEntry[]>;
  error?: string;
  /** Present when the agent's workingDir is a git repo. Sent on every
   *  fs-list response (cheap: one .git/HEAD read per call), so any tree
   *  refresh — manual or fsnotify-driven — also refreshes the branch
   *  badge. Absent for non-repos. */
  git?: GitStatus;
  ts: number;
}

/**
 * Sidecar's reply to an `fs-read` request. Wire-flat (no tagged union)
 * because the Go side has no ergonomic way to model one — the dashboard
 * normalizes this into the discriminated `FSReadResult` shape via the
 * server's REST face.
 *
 *   - result === 'text'   → `content` carries UTF-8 text, `size` set
 *   - result === 'image'  → `mime` + `base64` carry the image, `size` set
 *   - result === 'binary' → no content (cannot preview), `size` set
 *   - result === 'error'  → `error` carries human-readable reason
 */
export interface FSReadResponseEvent {
  kind: 'fs-read-response';
  machineId: string;
  agentId: string;
  requestId: string;
  path: string;
  result: 'text' | 'image' | 'binary' | 'error';
  content?: string;
  mime?: string;
  base64?: string;
  size?: number;
  error?: string;
  ts: number;
}

/** Unsolicited change notification from the sidecar's per-agent
 *  fsnotify watcher. `path` is the directory whose contents changed;
 *  the dashboard invalidates that level in the tree if it's currently
 *  expanded. Coalesced on the sidecar side with a ~250ms debounce so a
 *  noisy build doesn't flood the stream. */
export interface FSChangedEvent {
  kind: 'fs-changed';
  machineId: string;
  agentId: string;
  path: string;
  ts: number;
}

/** Sidecar update lifecycle (back on agent:lifecycle). The triple is
 *  scoped by (machineId, requestId): `started` lands once the sidecar
 *  picks up the verb; `downloaded` lands after sha256-verify + swap,
 *  immediately before the sidecar exits to restart; `failed` lands at
 *  any failed step with a human-readable reason. The "successfully
 *  running on the new version" signal isn't a dedicated event — the
 *  fresh sidecar's existing `machine-register` carries the new
 *  `sidecarVersion`, which the server matches against the request to
 *  close the loop. */
export interface SidecarUpdateStartedEvent {
  kind: 'sidecar-update-started';
  machineId: string;
  requestId: string;
  fromVersion: string;
  ts: number;
}

export interface SidecarUpdateDownloadedEvent {
  kind: 'sidecar-update-downloaded';
  machineId: string;
  requestId: string;
  fromVersion: string;
  toVersion: string;
  /** How the sidecar plans to restart: 'self' = sidecar re-spawns itself
   *  via `argus-sidecar start` (background mode), 'supervisor' = exits 0
   *  and lets systemd/launchd restart it, 'manual' = TTY foreground,
   *  the operator must restart by hand. The dashboard renders different
   *  copy on the toast for the manual case. */
  restartMode: 'self' | 'supervisor' | 'manual';
  ts: number;
}

export interface SidecarUpdateFailedEvent {
  kind: 'sidecar-update-failed';
  machineId: string;
  requestId: string;
  fromVersion: string;
  reason: string;
  ts: number;
}

/** Sidecar acks (back on agent:lifecycle). Server uses these to flip
 *  the Agent row's status promptly and surface spawn failures in the UI. */
export interface AgentSpawnedEvent {
  kind: 'agent-spawned';
  machineId: string;
  agentId: string;
  ts: number;
}

export interface AgentSpawnFailedEvent {
  kind: 'agent-spawn-failed';
  machineId: string;
  agentId: string;
  reason: string;
  ts: number;
}

export interface AgentDestroyedEvent {
  kind: 'agent-destroyed';
  machineId: string;
  agentId: string;
  ts: number;
}

export type MachineLifecycleAck =
  | AgentSpawnedEvent
  | AgentSpawnFailedEvent
  | AgentDestroyedEvent;

/** Anything the server expects on `agent:lifecycle`. Ordering matters:
 *  more specific kinds first so TS narrows correctly. */
export type AnyLifecycleEvent =
  | RegisterEvent
  | HeartbeatEvent
  | DeregisterEvent
  | MachineRegisterEvent
  | MachineHeartbeatEvent
  | AgentSpawnedEvent
  | AgentSpawnFailedEvent
  | AgentDestroyedEvent
  | FSListResponseEvent
  | FSReadResponseEvent
  | FSChangedEvent
  | SidecarUpdateStartedEvent
  | SidecarUpdateDownloadedEvent
  | SidecarUpdateFailedEvent;

/** Server → sidecar */
export interface Command {
  id: string;
  agentId: string;
  sessionId: string;
  /**
   * CLI-native conversation id. When present the sidecar passes
   * --resume (or the adapter's equivalent) so the CLI continues the
   * previous conversation.
   */
  externalId?: string;
  kind: 'execute' | 'cancel';
  prompt?: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
  /** optional adapter-specific options (model, flags, etc.) */
  options?: Record<string, unknown>;
}

/** Sidecar → server, streamed */
export interface ResultChunk {
  id: string;
  commandId: string;
  agentId: string;
  sessionId: string;
  seq: number;
  kind: ResultKind;
  /** incremental text; present for kind === 'delta' */
  delta?: string;
  /** full content for non-delta kinds (final summary, tool output, error, ...) */
  content?: string;
  meta?: Record<string, unknown>;
  ts: number;
  isFinal: boolean;
}

/**
 * Reported by the sidecar on the first turn of a session, so the server can
 * persist Session.externalId and pass it back on future commands for --resume.
 */
export interface SessionExternalIdEvent {
  kind: 'session-external-id';
  sessionId: string;
  commandId: string;
  externalId: string;
  ts: number;
}

// ─────────────────────────────────────────────────────────────────────
// Terminal (PTY) protocol
//
// Every message carries `terminalId` so the sidecar knows which PTY it
// targets. Kinds are identical on both the direct sidecar↔server link
// (preferred) and the legacy Redis streams (kept for reference; no
// longer used for live traffic).
//
// `data` payloads are base64-encoded raw bytes — terminals carry binary
// input (escape sequences, SIGINT 0x03, etc.).
// ─────────────────────────────────────────────────────────────────────

export interface TerminalOpen {
  kind: 'terminal-open';
  terminalId: string;
  agentId: string;
  /** Optional shell path; sidecar enforces an allowlist. Empty → default. */
  shell?: string;
  /** Optional cwd; defaults to the sidecar's workingDir. */
  cwd?: string;
  cols: number;
  rows: number;
  ts: number;
}

export interface TerminalInput {
  kind: 'terminal-input';
  terminalId: string;
  /** base64-encoded raw bytes from the user's keyboard. */
  data: string;
  ts: number;
}

export interface TerminalResize {
  kind: 'terminal-resize';
  terminalId: string;
  cols: number;
  rows: number;
  ts: number;
}

/** Server → sidecar: explicit close (otherwise PTY dies on shell exit). */
export interface TerminalCloseRequest {
  kind: 'terminal-close';
  terminalId: string;
  ts: number;
}

export type TerminalInputEvent =
  | TerminalOpen
  | TerminalInput
  | TerminalResize
  | TerminalCloseRequest;

export interface TerminalOutput {
  kind: 'terminal-output';
  terminalId: string;
  seq: number;
  /** base64-encoded raw bytes from the PTY. */
  data: string;
  ts: number;
}

export interface TerminalClosed {
  kind: 'terminal-closed';
  terminalId: string;
  exitCode: number;
  /** Optional human-readable reason: 'exit', 'killed', 'error: ...' */
  reason?: string;
  ts: number;
}

export type TerminalOutputEvent = TerminalOutput | TerminalClosed;

// ─────────────────────────────────────────────────────────────────────
// Sidecar ↔ server direct link
//
// Low-latency bidirectional WebSocket used for all terminal traffic
// (PTY input/output/resize/close). Commands, lifecycle and session
// results continue to flow over Redis Streams — those don't sit on the
// ~50ms-per-keystroke hot path and benefit from Stream's durability.
//
// Handshake: sidecar dials `{SIDECAR_LINK_PATH}?id=<sidecarId>&token=<shared>`,
// sends `hello`, waits for `hello-ack`. After that the link is a
// symmetric JSON frame channel using the `TerminalInputEvent` /
// `TerminalOutputEvent` kinds defined above.
// ─────────────────────────────────────────────────────────────────────

export const SIDECAR_LINK_PATH = '/sidecar-link';

export interface SidecarHello {
  kind: 'hello';
  sidecarId: string;
  /** Client-side wallclock; server echoes in `hello-ack` so sidecar can
   *  measure link RTT for diagnostics (not used for correctness). */
  ts: number;
}

export interface SidecarHelloAck {
  kind: 'hello-ack';
  /** Server wallclock — sidecar logs drift if > ~5s. */
  ts: number;
  /** Milliseconds the server will tolerate without a client ping before
   *  the link is assumed dead and closed. Advisory only. */
  idleTimeoutMs: number;
}

export type SidecarLinkFrame =
  | SidecarHello
  | SidecarHelloAck
  | TerminalInputEvent
  | TerminalOutputEvent;

/** Redis stream key helpers (commands / lifecycle / results / control —
 *  terminal traffic goes over the sidecar link, see SIDECAR_LINK_PATH). */
export const streamKeys = {
  /** All lifecycle events (agent + machine) ride one stream so the
   *  server's single sweep loop can preserve causal ordering between
   *  machine-register and agent-register. */
  lifecycle: 'agent:lifecycle',
  command: (agentId: string) => `agent:${agentId}:cmd`,
  result: (agentId: string) => `agent:${agentId}:result`,
  /** Per-machine control plane: server publishes Create/Destroy/Sync
   *  agent commands here; the sidecar reads them with its own group
   *  so a server restart doesn't replay everything. */
  machineControl: (machineId: string) => `machine:${machineId}:control`,
};

export const consumerGroups = {
  /** server-side consumer group reading result streams */
  server: 'server',
  /** server-side consumer group reading lifecycle events */
  lifecycle: 'server-lifecycle',
  /** per-machine consumer group on the machine control stream */
  machine: (machineId: string) => `machine-${machineId}`,
  /** per-agent consumer group an agent supervisor uses on its own
   *  command stream. Naming the group after the agent (rather than
   *  the machine or sidecar) lets two supervisors briefly overlap
   *  during a daemon restart and cooperatively drain the pending
   *  entry list instead of double-delivering commands. */
  sidecar: (agentId: string) => `sidecar-${agentId}`,
};
