import { cn } from '../../lib/utils';

/**
 * Renders a unified diff with per-line colors (green adds / red removes /
 * neutral context) plus a violet hunk header. We skip the `--- a/...` and
 * `+++ b/...` file headers because the caller already names the file —
 * showing them again is noise.
 *
 * `maxHeightClass` caps the scroll height; the default keeps each block
 * compact (used inline in `ToolPill`). Pass `''` (or `max-h-none`) when
 * rendering inside a pane that owns its own scroll, so the diff expands
 * fully instead of nesting a second scrollbar.
 */
export function DiffBlock({
  text,
  maxHeightClass = 'max-h-36',
}: {
  text: string;
  maxHeightClass?: string;
}) {
  const lines = text.split('\n');
  return (
    <div
      className={cn(
        'overflow-auto rounded-md bg-surface-1/50 px-0 py-1 text-[11px] font-mono leading-relaxed no-scrollbar',
        maxHeightClass,
      )}
    >
      {lines.map((line, i) => {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) return null;
        // Per-line colors are paired light/dark: light needs darker
        // foregrounds + a higher-opacity background to keep
        // contrast against the white page; dark inherits the
        // original (lighter foregrounds, near-transparent bg).
        let cls = 'text-fg-tertiary';
        let bg = '';
        if (line.startsWith('@@')) {
          cls = 'text-violet-700 dark:text-violet-400';
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          cls = 'text-emerald-700 dark:text-emerald-300';
          bg = 'bg-emerald-500/10 dark:bg-emerald-500/5';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          cls = 'text-red-700 dark:text-red-400';
          bg = 'bg-red-500/10 dark:bg-red-500/5';
        } else if (line.startsWith('…')) {
          cls = 'text-fg-tertiary italic';
        }
        return (
          <div key={i} className={cn('px-3 whitespace-pre-wrap break-all', cls, bg)}>
            {line || '\u00A0'}
          </div>
        );
      })}
    </div>
  );
}
