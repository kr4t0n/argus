import { Link, useLocation } from 'react-router-dom';
import { User } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { cn } from '../lib/utils';

/**
 * Bottom-of-sidebar user row. Click to navigate to `/user`, the
 * personal-overview page (activity heatmap and future per-user
 * widgets). Active state highlights when the route matches, so the
 * row reads as a tab rather than a one-shot button.
 */
export function UserRow() {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const active = location.pathname.startsWith('/user');
  return (
    <Link
      to="/user"
      className={cn(
        'shrink-0 flex items-center gap-2 border-t border-default px-4 py-2.5 text-[12px] transition-colors',
        active
          ? 'bg-surface-1 text-fg-primary'
          : 'text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary',
      )}
    >
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-secondary">
        <User className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1 truncate">{user?.email ?? 'You'}</div>
    </Link>
  );
}
