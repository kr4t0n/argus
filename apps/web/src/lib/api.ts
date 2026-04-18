import type {
  AgentDTO,
  CommandDTO,
  CreateCommandRequest,
  CreateSessionRequest,
  LoginResponse,
  OpenTerminalRequest,
  ResultChunkDTO,
  SessionDTO,
  TerminalDTO,
} from '@argus/shared-types';
import { getToken } from './auth';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) msg = body.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    http<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  me: () => http<{ user: { id: string; email: string; role: string } }>('/auth/me'),

  listAgents: (opts?: { includeArchived?: boolean }) =>
    http<AgentDTO[]>(
      `/agents${opts?.includeArchived ? '?includeArchived=true' : ''}`,
    ),
  getAgent: (id: string) => http<AgentDTO>(`/agents/${id}`),
  archiveAgent: (id: string) =>
    http<AgentDTO>(`/agents/${id}/archive`, { method: 'POST' }),
  unarchiveAgent: (id: string) =>
    http<AgentDTO>(`/agents/${id}/unarchive`, { method: 'POST' }),

  listSessions: (opts?: { includeArchived?: boolean }) =>
    http<SessionDTO[]>(
      `/sessions${opts?.includeArchived ? '?includeArchived=true' : ''}`,
    ),
  getSession: (id: string) =>
    http<{
      session: SessionDTO;
      commands: CommandDTO[];
      chunks: ResultChunkDTO[];
    }>(`/sessions/${id}`),
  getSessionChunks: (id: string, afterSeq = 0) =>
    http<{ commands: CommandDTO[]; chunks: ResultChunkDTO[] }>(
      `/sessions/${id}/chunks?afterSeq=${afterSeq}`,
    ),
  createSession: (body: CreateSessionRequest) =>
    http<{ session: SessionDTO; command: CommandDTO | null }>(`/sessions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  renameSession: (id: string, title: string) =>
    http<SessionDTO>(`/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  archiveSession: (id: string) =>
    http<SessionDTO>(`/sessions/${id}/archive`, { method: 'POST' }),
  unarchiveSession: (id: string) =>
    http<SessionDTO>(`/sessions/${id}/unarchive`, { method: 'POST' }),
  deleteSession: (id: string) => http<void>(`/sessions/${id}`, { method: 'DELETE' }),

  sendCommand: (sessionId: string, body: CreateCommandRequest) =>
    http<CommandDTO>(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  cancelCommand: (id: string) =>
    http<CommandDTO>(`/commands/${id}/cancel`, { method: 'POST' }),

  // Terminals
  openTerminal: (agentId: string, body: OpenTerminalRequest = {}) =>
    http<TerminalDTO>(`/agents/${agentId}/terminals`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listTerminals: (agentId: string) =>
    http<TerminalDTO[]>(`/agents/${agentId}/terminals`),
  closeTerminal: (id: string) =>
    http<TerminalDTO>(`/terminals/${id}`, { method: 'DELETE' }),
};
