import { io, Socket } from 'socket.io-client';
import type {
  AgentDTO,
  ClientToServerEvents,
  CommandDTO,
  ResultChunkDTO,
  ServerToClientEvents,
  SessionDTO,
} from '@argus/shared-types';
import { WS_NAMESPACE } from '@argus/shared-types';
import { getToken } from './auth';

const BASE = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'http://localhost:4000';

export type WSSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: WSSocket | null = null;
type Handler = {
  onAgentUpsert?: (a: AgentDTO) => void;
  onAgentStatus?: (p: { id: string; status: AgentDTO['status'] }) => void;
  onSessionCreated?: (s: SessionDTO) => void;
  onSessionUpdated?: (s: SessionDTO) => void;
  onSessionStatus?: (p: { id: string; status: SessionDTO['status'] }) => void;
  onCommandCreated?: (c: CommandDTO) => void;
  onCommandUpdated?: (c: CommandDTO) => void;
  onChunk?: (c: ResultChunkDTO) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
};

const handlers = new Set<Handler>();

export function ensureSocket(): WSSocket {
  if (socket) return socket;
  const token = getToken();
  socket = io(`${BASE}${WS_NAMESPACE}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
  }) as WSSocket;
  socket.on('connect', () => handlers.forEach((h) => h.onConnect?.()));
  socket.on('disconnect', () => handlers.forEach((h) => h.onDisconnect?.()));
  socket.on('agent:upsert', (a) => handlers.forEach((h) => h.onAgentUpsert?.(a)));
  socket.on('agent:status', (p) => handlers.forEach((h) => h.onAgentStatus?.(p)));
  socket.on('session:created', (s) => handlers.forEach((h) => h.onSessionCreated?.(s)));
  socket.on('session:updated', (s) => handlers.forEach((h) => h.onSessionUpdated?.(s)));
  socket.on('session:status', (p) => handlers.forEach((h) => h.onSessionStatus?.(p)));
  socket.on('command:created', (c) => handlers.forEach((h) => h.onCommandCreated?.(c)));
  socket.on('command:updated', (c) => handlers.forEach((h) => h.onCommandUpdated?.(c)));
  socket.on('chunk', (c) => handlers.forEach((h) => h.onChunk?.(c)));
  return socket;
}

export function subscribeHandler(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

export function resetSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  handlers.clear();
}

export function joinAgent(agentId: string) {
  ensureSocket().emit('subscribe:agent', agentId);
}
export function leaveAgent(agentId: string) {
  ensureSocket().emit('unsubscribe:agent', agentId);
}
export function joinSession(sessionId: string) {
  ensureSocket().emit('subscribe:session', sessionId);
}
export function leaveSession(sessionId: string) {
  ensureSocket().emit('unsubscribe:session', sessionId);
}
