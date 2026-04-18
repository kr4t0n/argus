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
  /**
   * Whether this sidecar has a PTY runner attached (`terminal.enabled` in
   * its YAML). Controls whether the dashboard exposes the Terminal pane
   * for this agent; the server also uses it to reject terminal-open
   * requests before they hit the sidecar link.
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

/** Redis stream key helpers (commands / lifecycle / results only —
 *  terminal traffic goes over the sidecar link, see SIDECAR_LINK_PATH). */
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
