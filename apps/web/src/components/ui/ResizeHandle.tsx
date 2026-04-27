import { useCallback, useRef } from 'react';
import { cn } from '../../lib/utils';

type Props = {
  /** Which edge this handle lives on — determines drag direction. */
  side: 'left' | 'right';
  /** Called on every mousemove during a drag with the new width in px. */
  onResize: (widthPx: number) => void;
  /** Anchor element whose bounding-rect we measure against. */
  targetRef: React.RefObject<HTMLElement>;
  className?: string;
};

/**
 * A 6px-wide drag rail you drop onto the edge of a panel. Lives in
 * absolute positioning above the panel's content so clicks land on it
 * instead of the xterm canvas / scroll area behind.
 *
 * We compute the new width from the mouse's clientX relative to the
 * *targetRef*'s bounding rect on every frame. That means the handle
 * works regardless of where the panel sits in its parent — no need to
 * thread the container ref through the store.
 */
export function ResizeHandle({ side, onResize, targetRef, className }: Props) {
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      document.body.style.cursor = 'col-resize';
      // Disable selection while dragging so the user doesn't highlight
      // random text when they overshoot the handle.
      document.body.style.userSelect = 'none';
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const rect = targetRef.current?.getBoundingClientRect();
      if (!rect) return;
      // For a handle on the LEFT edge of a right-anchored pane, width
      // grows as the mouse moves left. For a handle on the RIGHT edge
      // of a left-anchored pane (sidebar), width grows as it moves right.
      const next =
        side === 'left' ? rect.right - e.clientX : e.clientX - rect.left;
      onResize(next);
    },
    [onResize, side, targetRef],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore — already released */
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        'group absolute top-0 bottom-0 z-20 w-1.5 cursor-col-resize',
        'flex items-center justify-center',
        side === 'left' ? '-left-[3px]' : '-right-[3px]',
        className,
      )}
    >
      {/* The visible 1px rail — transparent at rest, brightens on hover/drag. */}
      <span
        className={cn(
          'h-full w-px bg-transparent transition-colors',
          'group-hover:bg-default-strong group-active:bg-blue-500',
        )}
      />
    </div>
  );
}
