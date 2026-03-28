'use client';

import { cn } from '@/lib/utils';

interface StatusIndicatorProps {
  status: 'idle' | 'working' | 'paused' | 'disabled' | string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Real-time status indicator dot with animated states:
 * - idle: pulsing green dot
 * - working: spinning blue indicator
 * - paused: static yellow dot
 * - disabled: static gray dot
 */
export function StatusIndicator({ status, size = 'sm', className }: StatusIndicatorProps) {
  const sizeClasses = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5';

  return (
    <span className={cn('relative inline-flex', className)}>
      {status === 'idle' && (
        <>
          <span
            className={cn(
              'absolute inline-flex rounded-full bg-green-400 opacity-75 animate-ping',
              sizeClasses,
            )}
          />
          <span
            className={cn(
              'relative inline-flex rounded-full bg-green-500',
              sizeClasses,
            )}
          />
        </>
      )}
      {status === 'working' && (
        <>
          <span
            className={cn(
              'relative inline-flex rounded-full border-2 border-blue-500 border-t-transparent animate-spin',
              sizeClasses,
            )}
          />
        </>
      )}
      {status === 'paused' && (
        <span
          className={cn(
            'relative inline-flex rounded-full bg-amber-500',
            sizeClasses,
          )}
        />
      )}
      {status === 'disabled' && (
        <span
          className={cn(
            'relative inline-flex rounded-full bg-slate-400 dark:bg-slate-600',
            sizeClasses,
          )}
        />
      )}
    </span>
  );
}
