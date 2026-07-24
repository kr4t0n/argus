import { io, Socket } from 'socket.io-client';
import type {
  BackgroundTaskDTO,
  ClientToServerEvents,
  CommandDTO,
  MachineDTO,
  ProjectDTO,
  ResultChunkDTO,
  ServerToClientEvents,
  SessionDTO,
  SessionStatusEvent,
  SidecarUpdatePlanEntry,
  TerminalClosedMessage,
  TerminalDTO,
  TerminalOutputMessage,
} from '@argus/shared-types';
import { WS_NAMESPACE } from '@argus/shared-types';
import { getToken } from './auth';
import { wsBaseUrl } from './host';

const BASE = wsBaseUrl();

export type WSSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: WSSocket | null = null;
type Handler = {
  onMachineUpsert?: (m: MachineDTO) => void;
  onMachineStatus?: (p: { id: string; status: MachineDTO['status'] }) => void;
  onMachineRemoved?: (p: { id: string }) => void;
  onProjectUpsert?: (p: ProjectDTO) => void;
  onSessionCreated?: (s: SessionDTO) => void;
  onSessionUpdated?: (s: SessionDTO) => void;
  onSessionStatus?: (p: SessionStatusEvent) => void;
  onSessionCloneFailed?: (p: { sessionId: string; reason: string }) => void;
  onCommandCreated?: (c: CommandDTO) => void;
  onCommandUpdated?: (c: CommandDTO) => void;
  onChunk?: (c: ResultChunkDTO) => void;
  onTerminalCreated?: (t: TerminalDTO) => void;
  onTerminalUpdated?: (t: TerminalDTO) => void;
  onTerminalOutput?: (m: TerminalOutputMessage) => void;
  onTerminalClosed?: (m: TerminalClosedMessage) => void;
  onFSChanged?: (p: { path: string; machineId?: string; workingDir?: string }) => void;
  onGitChanged?: (p: { machineId?: string; workingDir?: string }) => void;
  onSidecarUpdateStarted?: (p: {
    machineId: string;
    requestId: string;
    fromVersion: string;
  }) => void;
  onSidecarUpdateDownloaded?: (p: {
    machineId: string;
    requestId: string;
    fromVersion: string;
    toVersion: string;
    restartMode: 'self' | 'supervisor' | 'manual';
  }) => void;
  onSidecarUpdateCompleted?: (p: {
    machineId: string;
    requestId: string;
    fromVersion: string;
    toVersion: string;
  }) => void;
  onSidecarUpdateFailed?: (p: {
    machineId: string;
    requestId: string;
    fromVersion: string;
    reason: string;
  }) => void;
  onSidecarUpdateBatchProgress?: (p: { batchId: string; plan: SidecarUpdatePlanEntry[] }) => void;
  onBackgroundTaskUpdated?: (t: BackgroundTaskDTO) => void;
  onBackgroundTaskRemoved?: (p: {
    machineId: string;
    workingDir: string;
    taskId: string;
  }) => void;
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
  socket.on('connect', () => {
    // Socket.io rooms are per-CONNECTION, so a reconnect drops every
    // membership server-side. Nothing re-joined them before, so a
    // network blip silently stopped `fs:changed` / `git:changed` until
    // the subscribing component happened to remount. Replay from the
    // refcount map (below) so live updates survive a reconnect.
    for (const { machineId, workingDir } of projectRooms.values()) {
      socket?.emit('subscribe:project', { machineId, workingDir });
    }
    handlers.forEach((h) => h.onConnect?.());
  });
  socket.on('disconnect', () => handlers.forEach((h) => h.onDisconnect?.()));
  socket.on('machine:upsert', (m) => handlers.forEach((h) => h.onMachineUpsert?.(m)));
  socket.on('machine:status', (p) => handlers.forEach((h) => h.onMachineStatus?.(p)));
  socket.on('machine:removed', (p) => handlers.forEach((h) => h.onMachineRemoved?.(p)));
  socket.on('project:upsert', (p) => handlers.forEach((h) => h.onProjectUpsert?.(p)));
  socket.on('session:created', (s) => handlers.forEach((h) => h.onSessionCreated?.(s)));
  socket.on('session:updated', (s) => handlers.forEach((h) => h.onSessionUpdated?.(s)));
  socket.on('session:status', (p) => handlers.forEach((h) => h.onSessionStatus?.(p)));
  socket.on('session:clone-failed', (p) => handlers.forEach((h) => h.onSessionCloneFailed?.(p)));
  socket.on('command:created', (c) => handlers.forEach((h) => h.onCommandCreated?.(c)));
  socket.on('command:updated', (c) => handlers.forEach((h) => h.onCommandUpdated?.(c)));
  socket.on('chunk', (c) => handlers.forEach((h) => h.onChunk?.(c)));
  socket.on('terminal:created', (t) => handlers.forEach((h) => h.onTerminalCreated?.(t)));
  socket.on('terminal:updated', (t) => handlers.forEach((h) => h.onTerminalUpdated?.(t)));
  socket.on('terminal:output', (m) => handlers.forEach((h) => h.onTerminalOutput?.(m)));
  socket.on('terminal:closed', (m) => handlers.forEach((h) => h.onTerminalClosed?.(m)));
  socket.on('fs:changed', (p) => handlers.forEach((h) => h.onFSChanged?.(p)));
  socket.on('git:changed', (p) => handlers.forEach((h) => h.onGitChanged?.(p)));
  socket.on('sidecar-update:started', (p) =>
    handlers.forEach((h) => h.onSidecarUpdateStarted?.(p)),
  );
  socket.on('sidecar-update:downloaded', (p) =>
    handlers.forEach((h) => h.onSidecarUpdateDownloaded?.(p)),
  );
  socket.on('sidecar-update:completed', (p) =>
    handlers.forEach((h) => h.onSidecarUpdateCompleted?.(p)),
  );
  socket.on('sidecar-update:failed', (p) => handlers.forEach((h) => h.onSidecarUpdateFailed?.(p)));
  socket.on('sidecar-update:batch-progress', (p) =>
    handlers.forEach((h) => h.onSidecarUpdateBatchProgress?.(p)),
  );
  socket.on('background-task:updated', (t) =>
    handlers.forEach((h) => h.onBackgroundTaskUpdated?.(t)),
  );
  socket.on('background-task:removed', (p) =>
    handlers.forEach((h) => h.onBackgroundTaskRemoved?.(p)),
  );
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
  // Membership dies with the connection, and every holder is a React
  // effect that will re-join on its next mount — a surviving count here
  // would suppress that re-join and leave the room permanently unjoined.
  projectRooms.clear();
}

export function joinSession(sessionId: string) {
  ensureSocket().emit('subscribe:session', sessionId);
}
export function leaveSession(sessionId: string) {
  ensureSocket().emit('unsubscribe:session', sessionId);
}
export function joinTerminal(terminalId: string) {
  ensureSocket().emit('subscribe:terminal', terminalId);
}
export function leaveTerminal(terminalId: string) {
  ensureSocket().emit('unsubscribe:terminal', terminalId);
}
/**
 * Project-room membership is REFCOUNTED because several components
 * subscribe to the same (machineId, workingDir) independently —
 * FileTree, GitLogPanel, ProgressPane, and the file-tab auto-refresh
 * hook. Socket.io's `leave` is not refcounted, so without this the
 * first component to unmount would kick the socket out of the room and
 * silently starve every other subscriber of `fs:changed` / `git:changed`.
 * (Latent until now only because ContextPane renders those panels as
 * mutually exclusive tabs.)
 *
 * The map doubles as the replay list for the reconnect handler above.
 */
type ProjectRoom = { machineId: string; workingDir: string; holders: number };
// Keyed by a joined string but CARRYING the parts, so the reconnect
// replay never has to parse them back out — a workingDir can contain
// whatever separator we'd otherwise pick.
const projectRooms = new Map<string, ProjectRoom>();
const roomKey = (machineId: string, workingDir: string) => `${machineId}\n${workingDir}`;

export function joinProject(machineId: string, workingDir: string) {
  const key = roomKey(machineId, workingDir);
  const room = projectRooms.get(key);
  if (room) {
    // Already joined on this connection; counting is all that's left.
    room.holders += 1;
    return;
  }
  projectRooms.set(key, { machineId, workingDir, holders: 1 });
  ensureSocket().emit('subscribe:project', { machineId, workingDir });
}
export function leaveProject(machineId: string, workingDir: string) {
  const key = roomKey(machineId, workingDir);
  const room = projectRooms.get(key);
  if (room && room.holders > 1) {
    room.holders -= 1;
    return;
  }
  projectRooms.delete(key);
  ensureSocket().emit('unsubscribe:project', { machineId, workingDir });
}
export function sendTerminalInput(terminalId: string, dataB64: string) {
  ensureSocket().emit('terminal:input', { terminalId, data: dataB64 });
}
export function sendTerminalResize(terminalId: string, cols: number, rows: number) {
  ensureSocket().emit('terminal:resize', { terminalId, cols, rows });
}
export function sendTerminalClose(terminalId: string) {
  ensureSocket().emit('terminal:close', terminalId);
}
