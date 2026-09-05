import { Link, useLocation } from 'react-router-dom';
import { Keyboard } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { usePaletteStore } from '../stores/paletteStore';
import { cn } from '../lib/utils';

/**
 * The sidebar footer: who you are, and the way into the keyboard help.
 *
 * Sign-out used to live here too and has moved to `/user` (see
 * `SignOutAction` in `pages/UserPanel.tsx`). A one-click sign-out sitting
 * permanently beneath every session row is a misclick with a real cost,
 * and it was the only other thing in this row competing for the eye —
 * which mattered because the keyboard glyph is the app's ONLY affordance
 * that doesn't require already knowing a keyboard binding.
 */
export function UserRow() {
  const user = useAuthStore((s) => s.user);
  const openPalette = usePaletteStore((s) => s.open);
  const location = useLocation();
  const active = location.pathname.startsWith('/user');
  const initial = (user?.email ?? '?').trim().charAt(0).toUpperCase();
  return (
    // `pr-2.5` rather than `pr-2`: the button carries its own `p-1.5`, so
    // matching the row padding would put the GLYPH 2px right of everything
    // above it. The sidebar aligns icons and meta text to a 16px right
    // rail — the header's collapse chevron (`pr-4`, no inner padding) and
    // every session row's timestamp (`px-2` scroller + `px-2` row) both
    // land there — and 10px + the button's 6px is what puts this on it.
    <div className="shrink-0 flex items-center gap-1 pl-2 pr-2.5 py-2">
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
      {/* The mouse path to the keyboard help, and the only thing in the app
          that reveals ⌘/ exists. Always visible on purpose: an entry point
          you have to discover by hovering would not break the circle where
          finding the shortcuts requires knowing a shortcut. */}
      <button
        type="button"
        onClick={() => openPalette('help')}
        title="keyboard shortcuts (⌘/)"
        aria-label="keyboard shortcuts"
        className="shrink-0 rounded-md p-1.5 text-fg-tertiary transition-colors hover:bg-surface-1 hover:text-fg-primary"
      >
        <Keyboard className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
