import type { AgentDTO, SessionDTO } from '@argus/shared-types';
import { cn } from '../../lib/utils';

type Status = AgentDTO['status'] | SessionDTO['status'];

const map: Record<Status, string> = {
  online: 'status-online',
  busy: 'status-busy',
  error: 'status-error',
  offline: 'status-offline',
  active: 'status-busy',
  idle: 'status-offline',
  done: 'status-online',
  failed: 'status-error',
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span className={cn('status-dot', map[status], className)} />;
}
