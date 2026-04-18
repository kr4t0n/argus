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

/** Redis stream key helpers */
export const streamKeys = {
  lifecycle: 'agent:lifecycle',
  command: (agentId: string) => `agent:${agentId}:cmd`,
  result: (agentId: string) => `agent:${agentId}:result`,
};

export const consumerGroups = {
  /** server-side consumer group reading result streams */
  server: 'server',
  /** server-side consumer group reading lifecycle events */
  lifecycle: 'server-lifecycle',
  /** per-sidecar consumer group on its command stream */
  sidecar: (agentId: string) => `sidecar-${agentId}`,
};
