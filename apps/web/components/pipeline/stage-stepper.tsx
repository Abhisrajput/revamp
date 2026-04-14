'use client';

import { memo, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { CheckCircle, Loader2, Lock, AlertCircle } from 'lucide-react';
import type { StageState } from '@revamp/core';

interface StageStepperProps {
  stages: StageState[];
  activeIndex: number;
  onStageClick: (index: number) => void;
}

const statusIcon = (status: StageState['status']) => {
  switch (status) {
    case 'completed':
    case 'approved':
      return <CheckCircle className="h-4 w-4 text-white" />;
    case 'generating':
    case 'validating':
      return <Loader2 className="h-4 w-4 text-white animate-spin" />;
    case 'failed':
      return <AlertCircle className="h-4 w-4 text-white" />;
    case 'locked':
      return <Lock className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />;
    default:
      return null;
  }
};

const statusColor = (status: StageState['status'], isActive: boolean) => {
  if (status === 'completed' || status === 'approved') return 'bg-green-600 text-white';
  if (status === 'generating' || status === 'validating') return 'bg-primary-600 text-white';
  if (status === 'failed') return 'bg-red-600 text-white';
  if (isActive) return 'bg-primary-600 text-white ring-4 ring-primary-100 dark:ring-primary-900/30';
  if (status === 'locked') return 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500';
  return 'bg-slate-300 dark:bg-slate-600 text-slate-600 dark:text-slate-300';
};

const connectorColor = (status: StageState['status']) => {
  if (status === 'completed' || status === 'approved') return 'bg-green-600';
  return 'bg-slate-200 dark:bg-slate-700';
};

export const StageStepper = memo(function StageStepper({ stages, activeIndex, onStageClick }: StageStepperProps) {
  const completedCount = useMemo(
    () => stages.filter((s) => s.status === 'completed' || s.status === 'approved').length,
    [stages],
  );

  const progressWidth = useMemo(
    () => `${(completedCount / stages.length) * 100}%`,
    [completedCount, stages.length],
  );

  const handleStageClick = useCallback(
    (index: number, isClickable: boolean) => {
      if (isClickable) onStageClick(index);
    },
    [onStageClick],
  );

  return (
    <div className="w-full">
      <div className="flex items-center gap-0.5">
        {stages.map((stage, index) => {
          const isActive = index === activeIndex;
          const isClickable = stage.status !== 'locked';
          const icon = statusIcon(stage.status);

          return (
            <div key={stage.name} className="flex-1 flex items-center">
              <button
                onClick={() => handleStageClick(index, isClickable)}
                disabled={!isClickable}
                className={cn(
                  'w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-all',
                  statusColor(stage.status, isActive),
                  isClickable ? 'cursor-pointer hover:scale-110' : 'cursor-not-allowed',
                )}
                title={`${stage.label} (${stage.status})`}
              >
                {icon || (index + 1)}
              </button>
              {index < stages.length - 1 && (
                <div className={cn('flex-1 h-1 mx-0.5 rounded-full transition-colors', connectorColor(stage.status))} />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid gap-1" style={{ gridTemplateColumns: `repeat(${stages.length}, 1fr)` }}>
        {stages.map((stage, index) => (
          <div key={stage.name} className="text-center px-0.5">
            <p className={cn(
              'text-[10px] font-medium leading-tight line-clamp-2',
              index === activeIndex
                ? 'text-primary-600 dark:text-primary-400'
                : 'text-slate-500 dark:text-slate-400',
            )}>
              {stage.label}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {completedCount} of {stages.length} stages complete
        </span>
        <div className="flex-1 mx-3 bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
          <div
            className="bg-green-600 h-1.5 rounded-full transition-all"
            style={{ width: progressWidth }}
          />
        </div>
      </div>
    </div>
  );
});
