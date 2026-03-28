'use client';

import { useCallback, useRef, memo } from 'react';
import { cn } from '@/lib/utils';

interface ResizeHandleProps {
  /** Direction the handle resizes in */
  direction: 'horizontal' | 'vertical';
  /** Current position callback — receives delta in px */
  onResize: (delta: number) => void;
  /** Called when drag ends */
  onResizeEnd?: () => void;
  /** Additional class names */
  className?: string;
}

/**
 * Drag-to-resize splitter bar.
 * Uses pointer capture for smooth cross-element dragging.
 */
export const ResizeHandle = memo(function ResizeHandle({
  direction,
  onResize,
  onResizeEnd,
  className,
}: ResizeHandleProps) {
  const isDragging = useRef(false);
  const lastPos = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging.current = true;
      lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [direction],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      const current = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = current - lastPos.current;
      if (delta !== 0) {
        onResize(delta);
        lastPos.current = current;
      }
    },
    [direction, onResize],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      isDragging.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      onResizeEnd?.();
    },
    [onResizeEnd],
  );

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className={cn(
        'group relative z-20 flex-shrink-0 select-none',
        direction === 'horizontal'
          ? 'w-1 cursor-col-resize hover:w-1.5 active:w-1.5'
          : 'h-1 cursor-row-resize hover:h-1.5 active:h-1.5',
        className,
      )}
    >
      {/* Visible handle line */}
      <div
        className={cn(
          'absolute transition-colors duration-150',
          'bg-slate-200 dark:bg-slate-700',
          'group-hover:bg-primary-400 dark:group-hover:bg-primary-500',
          'group-active:bg-primary-500 dark:group-active:bg-primary-400',
          direction === 'horizontal'
            ? 'top-0 bottom-0 left-1/2 -translate-x-1/2 w-px group-hover:w-0.5 group-active:w-0.5'
            : 'left-0 right-0 top-1/2 -translate-y-1/2 h-px group-hover:h-0.5 group-active:h-0.5',
        )}
      />
      {/* Wider invisible hit target */}
      <div
        className={cn(
          'absolute',
          direction === 'horizontal'
            ? 'top-0 bottom-0 -left-1.5 -right-1.5'
            : 'left-0 right-0 -top-1.5 -bottom-1.5',
        )}
      />
    </div>
  );
});
