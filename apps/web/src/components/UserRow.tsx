import { Link, useLocation } from 'react-router-dom';
import { LogOut, User } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { cn } from '../lib/utils';

/**
 * Bottom-of-sidebar user row. The label area links to `/user` (the
 * personal-overview page — activity heatmap and future per-user
 * widgets). A trailing logout icon-button signs the user out without
 * triggering the navigation. Active state highlights the link when
 * the route matches, so the row reads as a tab rather than a
 * one-shot button.
 *
 * The logout button is its own <button>, NOT nested inside the
 * <Link>, so a click can't accidentally navigate AND log out at the
 * same time. We keep the row visually unified via a shared border /
 * row layout in the wrapping <div>.
 */
export function UserRow() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const location = useLocation();
  const active = location.pathname.startsWith('/user');
  return (
    <div
      className={cn(
        'shrink-0 flex items-stretch border-t border-default text-[12px]',
        active && 'bg-surface-1',
      )}
    >
      <Link
        to="/user"
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 px-4 py-2.5 transition-colors',
          active
            ? 'text-fg-primary'
            : 'text-fg-tertiary hover:bg-surface-1 hover:text-fg-primary',
        )}
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-secondary">
          <User className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1 truncate">{user?.email ?? 'You'}</div>
      </Link>
      <button
        type="button"
        onClick={logout}
        title={user?.email ? `sign out ${user.email}` : 'sign out'}
        aria-label="sign out"
        className="shrink-0 px-3 text-fg-tertiary transition-colors hover:bg-surface-1 hover:text-fg-primary"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
