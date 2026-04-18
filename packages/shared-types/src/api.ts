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
  capabilities: string[];
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
