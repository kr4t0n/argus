import type {
  AgentDTO,
  CommandDTO,
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
  'agent:upsert': (agent: AgentDTO) => void;
  'agent:status': (payload: { id: string; status: AgentDTO['status'] }) => void;
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
}
