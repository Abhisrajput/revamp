'use client';

import { cn } from '@/lib/utils';

interface BudgetBarProps {
  spentCents: number;
  limitCents: number;
  warningThreshold?: number;
  hardStop?: boolean;
  compact?: boolean;
}

export function BudgetBar({
  spentCents,
  limitCents,
  warningThreshold = 0.8,
  hardStop = true,
  compact = false,
}: BudgetBarProps) {
  const pct = limitCents > 0 ? Math.min(spentCents / limitCents, 1) : 0;
  const isWarning = pct >= warningThreshold;
  const isOver = pct >= 1;

  const barColor = isOver
    ? 'bg-red-500'
    : isWarning
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${pct * 100}%` }} />
        </div>
        <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
          {(pct * 100).toFixed(0)}%
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-600 dark:text-slate-400">
          ${(spentCents / 100).toFixed(2)} / ${(limitCents / 100).toFixed(2)}
        </span>
        <span className={cn(
          'font-medium',
          isOver ? 'text-red-600 dark:text-red-400' : isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-slate-600 dark:text-slate-400',
        )}>
          {(pct * 100).toFixed(1)}%
          {hardStop && isOver && ' (STOPPED)'}
        </span>
      </div>
      <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}
