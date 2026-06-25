import type {
  AgentDTO,
  ApiKeyDTO,
  AttachmentDTO,
  BackgroundTasksResponse,
  CommandDTO,
  CreateAgentRequest,
  CreateApiKeyRequest,
  CreatedApiKey,
  CreateCommandRequest,
  CreateSessionRequest,
  FSListResponse,
  FSReadResponse,
  GitLogResponse,
  LoginResponse,
  MachineDTO,
  ModelCatalogResponse,
  ModelSelection,
  OpenTerminalRequest,
  ProjectDTO,
  ProjectNotesResponse,
  ResultChunkDTO,
  SessionDTO,
  SidecarUpdateAccepted,
  SidecarUpdateBatchAccepted,
  SidecarVersionInfo,
  TerminalDTO,
  UpdateUserExtensionsRequest,
  UserActivityResponse,
  UserExtensionsResponse,
  UserQuotaResponse,
  UserRulesResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { getToken } from './auth';
import { apiBaseUrl } from './host';

const BASE = apiBaseUrl();

/** Absolutize an API-base-relative path (e.g. an AttachmentDTO.url) so it
 *  can be used directly in `<img src>` / download links. The tokenized
 *  attachment urls authenticate via their `?t=` param, not a header. */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

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

  // Personal API keys — long-lived, revocable credentials for calling the
  // REST API from scripts/dashboards. Managed only over the JWT session
  // (the server refuses key-management requests authenticated by a key).
  listMyApiKeys: () => http<ApiKeyDTO[]>('/auth/api-keys'),
  createMyApiKey: (body: CreateApiKeyRequest) =>
    http<CreatedApiKey>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeMyApiKey: (id: string) =>
    http<{ revoked: boolean }>(`/auth/api-keys/${id}`, { method: 'DELETE' }),
  /** Smoke-test a freshly-minted key by hitting a read endpoint with it in
   *  the `X-API-Key` header (NOT the JWT). Returns the visible agent count
   *  on success. Only usable right after creation, while the plaintext is
   *  still in hand — stored keys are hashes and can't be replayed. */
  testApiKey: async (secret: string): Promise<number> => {
    const res = await fetch(`${BASE}/agents`, { headers: { 'X-API-Key': secret } });
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
    const agents = (await res.json()) as unknown;
    return Array.isArray(agents) ? agents.length : 0;
  },

  listAgents: (opts?: { includeArchived?: boolean }) =>
    http<AgentDTO[]>(`/agents${opts?.includeArchived ? '?includeArchived=true' : ''}`),
  getAgent: (id: string) => http<AgentDTO>(`/agents/${id}`),
  archiveAgent: (id: string) => http<AgentDTO>(`/agents/${id}/archive`, { method: 'POST' }),
  unarchiveAgent: (id: string) => http<AgentDTO>(`/agents/${id}/unarchive`, { method: 'POST' }),

  // Machines
  listMachines: (opts?: { includeArchived?: boolean }) =>
    http<MachineDTO[]>(`/machines${opts?.includeArchived ? '?includeArchived=true' : ''}`),
  getMachine: (id: string) => http<MachineDTO>(`/machines/${id}`),
  listMachineAgents: (id: string) => http<AgentDTO[]>(`/machines/${id}/agents`),
  createAgent: (machineId: string, body: CreateAgentRequest) =>
    http<AgentDTO>(`/machines/${machineId}/agents`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  destroyAgent: (machineId: string, agentId: string) =>
    http<void>(`/machines/${machineId}/agents/${agentId}`, { method: 'DELETE' }),
  deleteMachine: (id: string) =>
    http<void>(`/machines/${id}`, { method: 'DELETE' }),

  listSessions: (opts?: { includeArchived?: boolean }) =>
    http<SessionDTO[]>(`/sessions${opts?.includeArchived ? '?includeArchived=true' : ''}`),
  getSession: (id: string, opts?: { tailCommands?: number }) => {
    const q = new URLSearchParams();
    if (opts?.tailCommands) q.set('tailCommands', String(opts.tailCommands));
    const qs = q.toString();
    return http<{
      session: SessionDTO;
      commands: CommandDTO[];
      chunks: ResultChunkDTO[];
      hasMore: boolean;
    }>(`/sessions/${id}${qs ? `?${qs}` : ''}`);
  },
  getSessionChunks: (id: string, afterSeq = 0) =>
    http<{ commands: CommandDTO[]; chunks: ResultChunkDTO[] }>(
      `/sessions/${id}/chunks?afterSeq=${afterSeq}`,
    ),
  getSessionHistory: (id: string, beforeCommandId: string, limit = 20) => {
    const q = new URLSearchParams({ before: beforeCommandId, limit: String(limit) });
    return http<{
      commands: CommandDTO[];
      chunks: ResultChunkDTO[];
      hasMore: boolean;
    }>(`/sessions/${id}/history?${q.toString()}`);
  },
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
  archiveSession: (id: string) => http<SessionDTO>(`/sessions/${id}/archive`, { method: 'POST' }),
  unarchiveSession: (id: string) =>
    http<SessionDTO>(`/sessions/${id}/unarchive`, { method: 'POST' }),
  /** Clear a session's `unread` marker once the user has opened it,
   *  removing the sidebar's dot (green or red). Leaves `status`
   *  untouched and is a no-op once already seen, so callers can
   *  fire-and-forget on every view. */
  markSessionSeen: (id: string) =>
    http<SessionDTO>(`/sessions/${id}/seen`, { method: 'POST' }),
  deleteSession: (id: string) => http<void>(`/sessions/${id}`, { method: 'DELETE' }),
  forkSession: (id: string, body: { commandId: string; title?: string }) =>
    http<SessionDTO>(`/sessions/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  sendCommand: (sessionId: string, body: CreateCommandRequest) =>
    http<CommandDTO>(`/sessions/${sessionId}/commands`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Model catalog for an agent's CLI — drives the model picker.
   *  Server-cached per agent (~1h); `refresh` bypasses the cache. */
  getModelCatalog: (agentId: string, opts?: { refresh?: boolean }) =>
    http<ModelCatalogResponse>(`/agents/${agentId}/models${opts?.refresh ? '?refresh=1' : ''}`),
  /** Replace the session-default model choice; null clears to "CLI
   *  default". Applies to subsequent turns. */
  setSessionModel: (id: string, modelSelection: ModelSelection | null) =>
    http<SessionDTO>(`/sessions/${id}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ modelSelection }),
    }),
  /** Upload one file ahead of sending a turn; returns its metadata + a
   *  tokenized url. The browser auto-sets the multipart Content-Type
   *  because the body is FormData (see the http() helper). */
  uploadAttachment: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return http<AttachmentDTO>('/attachments', { method: 'POST', body: fd });
  },
  cancelCommand: (id: string) => http<CommandDTO>(`/commands/${id}/cancel`, { method: 'POST' }),

  // Terminals
  openTerminal: (agentId: string, body: OpenTerminalRequest = {}) =>
    http<TerminalDTO>(`/agents/${agentId}/terminals`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listTerminals: (agentId: string) => http<TerminalDTO[]>(`/agents/${agentId}/terminals`),
  closeTerminal: (id: string) => http<TerminalDTO>(`/terminals/${id}`, { method: 'DELETE' }),

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

  // Server-side project metadata (today: the user-picked icon glyph),
  // keyed by (machineId, workingDir). One fetch hydrates the icon map
  // for every project across the fleet.
  listProjects: () => http<ProjectDTO[]>(`/projects`),

  // Per-project icon, same contract as setMachineIcon below: pass
  // `null` to reset, server emits project:upsert on success so every
  // connected dashboard converges; call sites update the store
  // optimistically to avoid the round-trip blink.
  setProjectIcon: (machineId: string, workingDir: string, iconKey: string | null) =>
    http<ProjectDTO>(`/projects/icon`, {
      method: 'PATCH',
      body: JSON.stringify({ machineId, workingDir, iconKey }),
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

  // Filesystem browsing (right-pane tree). `depth` asks the sidecar to
  // walk multiple levels in one round trip — the result hydrates the
  // tree cache for every returned path so expanding those folders is
  // instant. Omit or pass 1 for the historical single-level listing.
  listAgentDir: (agentId: string, path: string, showAll: boolean, depth?: number) => {
    const q = new URLSearchParams();
    if (path) q.set('path', path);
    if (showAll) q.set('showAll', 'true');
    if (depth && depth > 1) q.set('depth', String(depth));
    const qs = q.toString();
    return http<FSListResponse>(`/agents/${agentId}/fs/list${qs ? `?${qs}` : ''}`);
  },
  readAgentFile: (agentId: string, path: string) => {
    const q = new URLSearchParams({ path });
    return http<FSReadResponse>(`/agents/${agentId}/fs/read?${q.toString()}`);
  },

  /** Per-day command count for the current user (last 365 days). The
   *  response is dense — zero-days included — so the heatmap can map
   *  it directly to a 7-row × N-column grid. */
  getMyActivity: () => http<UserActivityResponse>('/me/activity'),

  /** Lifetime token totals across every session the user owns —
   *  parsed server-side with the same per-adapter `parseUsage` the
   *  per-session UsageBadge uses, so the totals never disagree. */
  getMyUsage: () => http<UserUsageResponse>('/me/usage'),

  /** Latest plan-quota snapshot per CLI, picked across the user's
   *  fleet of sidecars. Returns one row per agent type that has at
   *  least one report on file; agent types nobody has signed into are
   *  simply absent from the response. */
  getMyQuota: () => http<UserQuotaResponse>('/me/quota'),

  /** Free-form rules the user wants every CLI agent they spawn to
   *  follow. Empty string = no rules set. Sidecar sync to actual
   *  agent runtimes is a follow-up. */
  getMyRules: () => http<UserRulesResponse>('/me/rules'),
  setMyRules: (rules: string) =>
    http<UserRulesResponse>('/me/rules', {
      method: 'PUT',
      body: JSON.stringify({ rules }),
    }),

  /** Per-project scratchpad notes, keyed by the (machineId, workingDir)
   *  pair that defines a project. Empty string = no notes. Backs the
   *  Notes extension's panel in the session right pane. */
  getProjectNotes: (machineId: string, workingDir: string) => {
    const q = new URLSearchParams({ machineId, workingDir });
    return http<ProjectNotesResponse>(`/me/project-notes?${q.toString()}`);
  },
  setProjectNotes: (machineId: string, workingDir: string, notes: string) => {
    const q = new URLSearchParams({ machineId, workingDir });
    return http<ProjectNotesResponse>(`/me/project-notes?${q.toString()}`, {
      method: 'PUT',
      body: JSON.stringify({ notes }),
    });
  },

  /** Account-level opt-in extension flags, synced across browsers.
   *  Loaded at bootstrap to reconcile the local uiStore cache. */
  getMyExtensions: () => http<UserExtensionsResponse>('/me/extensions'),
  setMyExtensions: (ext: UpdateUserExtensionsRequest) =>
    http<UserExtensionsResponse>('/me/extensions', {
      method: 'PUT',
      body: JSON.stringify(ext),
    }),

  /** Active + recently-ended background tasks for one project — hydrates
   *  the Progress extension's panel on mount. The live socket
   *  (`background-task:updated` / `:removed`, scoped to the
   *  `subscribe:project` room) keeps it fresh afterwards. */
  listBackgroundTasks: (machineId: string, workingDir: string) => {
    const q = new URLSearchParams({ workingDir });
    return http<BackgroundTasksResponse>(`/machines/${machineId}/background-tasks?${q.toString()}`);
  },
  /** Remove one background task from the server's in-memory registry
   *  and broadcast the removal so every connected dashboard drops the
   *  card. Effect is global, not per-user. */
  dismissBackgroundTask: (machineId: string, workingDir: string, taskId: string) => {
    const q = new URLSearchParams({ workingDir });
    return http<void>(`/machines/${machineId}/background-tasks/${taskId}?${q.toString()}`, {
      method: 'DELETE',
    });
  },

  /** Recent commits for the agent's workingDir. The response also
   *  carries a fresh GitStatus so the panel header (branch /
   *  detached) renders in one round trip. */
  getAgentGitLog: (agentId: string, limit?: number) => {
    const q = new URLSearchParams();
    if (limit && limit > 0) q.set('limit', String(limit));
    const qs = q.toString();
    return http<GitLogResponse>(`/agents/${agentId}/git/log${qs ? `?${qs}` : ''}`);
  },
};
