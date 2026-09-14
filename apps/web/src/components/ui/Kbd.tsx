import type { ReactNode } from 'react';

/** A key cap. Shared so the command palette's footer hints and the
 *  shortcuts overlay render chords identically — they sit next to each
 *  other in the user's head even though they're different surfaces. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-default px-1 py-px font-sans text-[10px] text-fg-secondary">
      {children}
    </kbd>
  );
}
