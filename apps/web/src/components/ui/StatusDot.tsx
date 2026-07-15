import { cn } from '../../lib/utils';

// Union of every status the dot renders: machine ('online'/'offline'),
// the legacy busy/error tints, and session ('active'/'idle'/'failed').
type Status = 'online' | 'offline' | 'busy' | 'error' | 'active' | 'idle' | 'failed';

const map: Record<Status, string> = {
  online: 'status-online',
  busy: 'status-busy',
  error: 'status-error',
  offline: 'status-offline',
  active: 'status-busy',
  idle: 'status-offline',
  failed: 'status-error',
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span className={cn('status-dot', map[status], className)} />;
}
