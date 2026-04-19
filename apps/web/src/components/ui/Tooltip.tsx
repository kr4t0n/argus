import * as React from 'react';
import * as RTooltip from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils';

/**
 * Thin wrapper around `@radix-ui/react-tooltip`. We use Radix instead of
 * the browser-native `title` attribute because the latter is unreliable
 * on macOS — Safari often suppresses it entirely if the page hasn't
 * been clicked, Chrome on macOS has a >1s delay, and the multi-line
 * `\n` rendering varies per engine. Radix gives us deterministic
 * cross-browser hover/focus tooltips with the same dark theming as
 * the rest of the UI.
 *
 * `<TooltipProvider>` lives once at the app root (see main.tsx) so
 * every consumer reuses the same delay timer; per-tooltip overrides
 * still work via the `delayDuration` prop on the inner Provider that
 * Radix supports for nested cases.
 */

export const TooltipProvider = RTooltip.Provider;

type TooltipProps = {
  /** The element the tooltip anchors to. Wrapped in a Radix Trigger
   *  via `asChild`, so the child receives the trigger ref / aria props
   *  without an extra DOM node. The child must accept a ref. */
  children: React.ReactNode;
  /** Tooltip body. Anything React-renderable; pre-formatted multi-line
   *  text (key/value lists, breakdowns) is the typical use. */
  content: React.ReactNode;
  /** Which side of the trigger to render on. Defaults to `bottom`,
   *  matching where users naturally expect contextual info to appear. */
  side?: RTooltip.TooltipContentProps['side'];
  /** Pixel gap between trigger and content. */
  sideOffset?: number;
  /** Disables the tooltip entirely (e.g. when `content` is empty). The
   *  trigger is still rendered, just without the popup. */
  disabled?: boolean;
  className?: string;
};

export function Tooltip({
  children,
  content,
  side = 'bottom',
  sideOffset = 6,
  disabled = false,
  className,
}: TooltipProps) {
  if (disabled) return <>{children}</>;
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={sideOffset}
          className={cn(
            // Card surface — matches the dark theming used by Buttons
            // and the chunk panes. `shadow-lg` lifts it above the
            // header's border-b without needing a backdrop.
            'z-50 rounded-md border border-neutral-800 bg-neutral-950/95 px-2.5 py-1.5 text-xs text-neutral-200 shadow-lg',
            // Subtle in/out animation borrowed from the Radix recipe.
            'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0',
            'data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1',
            className,
          )}
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
