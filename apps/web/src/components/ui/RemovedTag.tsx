import { cn } from '../../lib/utils';

/**
 * "The host this ran on is gone."
 *
 * Sits alongside the `archived` pill and a session can carry both —
 * they're orthogonal: archive is a reversible hide, removal is the
 * machine's terminal tombstone. Amber rather than the neutral grey of
 * `archived` because it changes what the row can *do*, not just where
 * it's filed: the transcript still opens and reads in full, but
 * nothing can be run against it again.
 */
export function RemovedTag({ className }: { className?: string }) {
  return (
    <span
      title="this machine was removed — history is read-only"
      className={cn(
        'shrink-0 rounded bg-amber-500/10 px-1 py-px text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400',
        className,
      )}
    >
      removed
    </span>
  );
}
