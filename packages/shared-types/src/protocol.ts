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

/** Sidecar → server, on boot */
export interface RegisterEvent {
  kind: 'register';
  id: string;
  type: AgentType;
  machine: string;
  capabilities: string[];
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
// Multiplexed over two per-agent streams so we don't explode the number
// of Redis streams as terminals come and go. Every message carries
// `terminalId` so the sidecar knows which PTY it targets.
//
//   server  → sidecar:  agent:{id}:term:in   (open / input / resize / close)
//   sidecar → server :  agent:{id}:term:out  (output / close)
//
// `data` payloads are base64-encoded raw bytes — terminals carry binary
// input (escape sequences, SIGINT 0x03, etc.) and Redis stream values
// must be valid JSON strings.
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

/** Redis stream key helpers */
export const streamKeys = {
  lifecycle: 'agent:lifecycle',
  command: (agentId: string) => `agent:${agentId}:cmd`,
  result: (agentId: string) => `agent:${agentId}:result`,
  terminalIn: (agentId: string) => `agent:${agentId}:term:in`,
  terminalOut: (agentId: string) => `agent:${agentId}:term:out`,
};

export const consumerGroups = {
  /** server-side consumer group reading result streams */
  server: 'server',
  /** server-side consumer group reading lifecycle events */
  lifecycle: 'server-lifecycle',
  /** server-side consumer group reading terminal output streams */
  terminalOut: 'server-term',
  /** per-sidecar consumer group on its command stream */
  sidecar: (agentId: string) => `sidecar-${agentId}`,
  /** per-sidecar consumer group on its terminal input stream */
  sidecarTerminal: (agentId: string) => `sidecar-term-${agentId}`,
};
