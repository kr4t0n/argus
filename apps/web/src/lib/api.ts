import type {
  AgentDTO,
  CommandDTO,
  CreateAgentRequest,
  CreateCommandRequest,
  CreateSessionRequest,
  FSListResponse,
  FSReadResponse,
  LoginResponse,
  MachineDTO,
  OpenTerminalRequest,
  ResultChunkDTO,
  SessionDTO,
  SidecarUpdateAccepted,
  SidecarUpdateBatchAccepted,
  SidecarVersionInfo,
  TerminalDTO,
} from '@argus/shared-types';
import { getToken } from './auth';
import { apiBaseUrl } from './host';

const BASE = apiBaseUrl();

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

  // Machines
  listMachines: (opts?: { includeArchived?: boolean }) =>
    http<MachineDTO[]>(
      `/machines${opts?.includeArchived ? '?includeArchived=true' : ''}`,
    ),
  getMachine: (id: string) => http<MachineDTO>(`/machines/${id}`),
  listMachineAgents: (id: string) => http<AgentDTO[]>(`/machines/${id}/agents`),
  createAgent: (machineId: string, body: CreateAgentRequest) =>
    http<AgentDTO>(`/machines/${machineId}/agents`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  destroyAgent: (machineId: string, agentId: string) =>
    http<void>(`/machines/${machineId}/agents/${agentId}`, { method: 'DELETE' }),

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

  // Sidecar version + remote update
  getSidecarVersion: (machineId: string) =>
    http<SidecarVersionInfo>(`/machines/${machineId}/sidecar/version`),
  updateSidecar: (machineId: string) =>
    http<SidecarUpdateAccepted>(`/machines/${machineId}/sidecar/update`, {
      method: 'POST',
    }),
  updateAllSidecars: () =>
    http<SidecarUpdateBatchAccepted>(`/machines/sidecar/update-all`, {
      method: 'POST',
    }),

  // Per-machine icon. Pass `null` to reset to the frontend default.
  // The server emits machine:upsert on success so every connected
  // dashboard refreshes the glyph; we still optimistically update
  // machineStore at the call site to avoid the round-trip blink.
  setMachineIcon: (machineId: string, iconKey: string | null) =>
    http<MachineDTO>(`/machines/${machineId}/icon`, {
      method: 'PATCH',
      body: JSON.stringify({ iconKey }),
    }),

  // Filesystem browsing (right-pane tree)
  listAgentDir: (agentId: string, path: string, showAll: boolean) => {
    const q = new URLSearchParams();
    if (path) q.set('path', path);
    if (showAll) q.set('showAll', 'true');
    const qs = q.toString();
    return http<FSListResponse>(
      `/agents/${agentId}/fs/list${qs ? `?${qs}` : ''}`,
    );
  },
  readAgentFile: (agentId: string, path: string) => {
    const q = new URLSearchParams({ path });
    return http<FSReadResponse>(`/agents/${agentId}/fs/read?${q.toString()}`);
  },
};
