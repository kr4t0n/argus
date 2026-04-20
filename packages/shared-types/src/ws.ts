import type {
  AgentDTO,
  CommandDTO,
  MachineDTO,
  ResultChunkDTO,
  SessionDTO,
  TerminalClosedMessage,
  TerminalDTO,
  TerminalInputMessage,
  TerminalOutputMessage,
  TerminalResizeMessage,
} from './api';

/** WebSocket namespace the server exposes. */
export const WS_NAMESPACE = '/stream';

/** Client → server events */
export interface ClientToServerEvents {
  'subscribe:agent': (agentId: string) => void;
  'unsubscribe:agent': (agentId: string) => void;
  'subscribe:session': (sessionId: string) => void;
  'unsubscribe:session': (sessionId: string) => void;
  'subscribe:terminal': (terminalId: string) => void;
  'unsubscribe:terminal': (terminalId: string) => void;
  'terminal:input': (msg: TerminalInputMessage) => void;
  'terminal:resize': (msg: TerminalResizeMessage) => void;
  'terminal:close': (terminalId: string) => void;
}

/** Server → client events */
export interface ServerToClientEvents {
  'machine:upsert': (machine: MachineDTO) => void;
  'machine:status': (payload: { id: string; status: MachineDTO['status'] }) => void;
  'machine:removed': (payload: { id: string }) => void;
  'agent:upsert': (agent: AgentDTO) => void;
  'agent:status': (payload: { id: string; status: AgentDTO['status'] }) => void;
  'agent:removed': (payload: { id: string }) => void;
  /** Surfaces sidecar-side spawn errors (bad workingDir, missing binary, …)
   *  so the dashboard can show inline feedback on the create-agent flow. */
  'agent:spawn-failed': (payload: {
    machineId: string;
    agentId: string;
    reason: string;
  }) => void;
  'session:created': (session: SessionDTO) => void;
  'session:updated': (session: SessionDTO) => void;
  'session:status': (payload: { id: string; status: SessionDTO['status'] }) => void;
  'command:created': (command: CommandDTO) => void;
  'command:updated': (command: CommandDTO) => void;
  chunk: (chunk: ResultChunkDTO) => void;
  'terminal:created': (terminal: TerminalDTO) => void;
  'terminal:updated': (terminal: TerminalDTO) => void;
  'terminal:output': (msg: TerminalOutputMessage) => void;
  'terminal:closed': (msg: TerminalClosedMessage) => void;
  /** One of the agent's working-directory paths changed on disk
   *  (coalesced by the sidecar's debounced fsnotify). The dashboard
   *  re-fetches the listing for `path` if it's currently expanded in
   *  the right-pane file tree. */
  'fs:changed': (payload: { agentId: string; path: string }) => void;
}
