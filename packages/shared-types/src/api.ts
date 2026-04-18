import type {
  AgentStatus,
  AgentType,
  CommandStatus,
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

export interface AgentDTO {
  id: string;
  type: AgentType;
  machine: string;
  status: AgentStatus;
  /**
   * Whether this agent's sidecar runs a PTY host (`terminal.enabled`
   * in its YAML). Controls whether the dashboard exposes the Terminal
   * pane; the server also rejects terminal-open requests for agents
   * where this is false.
   */
  supportsTerminal: boolean;
  version: string | null;
  workingDir: string | null;
  lastHeartbeatAt: string;
  registeredAt: string;
  /** ISO timestamp; null means the agent is visible/unarchived. */
  archivedAt: string | null;
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
