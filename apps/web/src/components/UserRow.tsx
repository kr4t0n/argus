import { Link, useLocation } from 'react-router-dom';
import { Keyboard, LogOut } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { usePaletteStore } from '../stores/paletteStore';
import { cn } from '../lib/utils';

export function UserRow() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const openPalette = usePaletteStore((s) => s.open);
  const location = useLocation();
  const active = location.pathname.startsWith('/user');
  const initial = (user?.email ?? '?').trim().charAt(0).toUpperCase();
  return (
    <div className="group/row shrink-0 flex items-center gap-1 px-2 py-2">
      <Link
        to="/user"
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
          active
            ? 'bg-surface-2 text-fg-primary'
            : 'text-fg-secondary hover:bg-surface-1 hover:text-fg-primary',
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-fg-secondary">
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate">{user?.email ?? 'You'}</span>
      </Link>
      {/* The mouse path to the keyboard help, and the only thing in the
          app that reveals ⌘/ exists. Deliberately NOT hover-revealed like
          the sign-out button beside it: every other affordance for these
          bindings requires already knowing a binding, so an entry point
          you have to discover by hovering would not break that circle. */}
      <button
        type="button"
        onClick={() => openPalette('help')}
        title="keyboard shortcuts (⌘/)"
        aria-label="keyboard shortcuts"
        className="shrink-0 rounded-md p-1.5 text-fg-tertiary transition-colors hover:bg-surface-1 hover:text-fg-primary"
      >
        <Keyboard className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={logout}
        title={user?.email ? `sign out ${user.email}` : 'sign out'}
        aria-label="sign out"
        className="shrink-0 rounded-md p-1.5 text-fg-tertiary opacity-0 transition-opacity transition-colors hover:bg-surface-1 hover:text-fg-primary group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        <LogOut className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
