'use client';

import { memo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  CheckCircle,
  Loader2,
  Lock,
  Settings2,
  ScanSearch,
  PenLine,
  BookOpen,
  Compass,
  Code2,
  GitCompare,
  Wrench,
} from 'lucide-react';
import type { StageState } from '@/lib/stores/pipeline-types';
import { StageContextMenu } from './stage-context-menu';

// ─── Stage icons (unique per stage) ────────────────────────────

const STAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  SCAN: Settings2,
  DECODE: ScanSearch,
  BLUEPRINT: PenLine,
  SPEC_LOCK: BookOpen,
  ARCHITECT: Compass,
  FORGE: Code2,
  SHADOW_RUN: GitCompare,
  EVOLVE: Wrench,
};

// ─── Status badge (tiny overlay on the stage icon) ─────────────

function StatusDot({ status }: { status: StageState['status'] }) {
  const base = 'absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-slate-800';

  switch (status) {
    case 'completed':
    case 'approved':
      return (
        <span className={cn(base, 'bg-green-500')}>
          <CheckCircle className="w-2 h-2 text-white absolute inset-0.5" />
        </span>
      );
    case 'generating':
    case 'validating':
      return (
        <span className={cn(base, 'bg-primary-500')}>
          <Loader2 className="w-2 h-2 text-white absolute inset-0.5 animate-spin" />
        </span>
      );
    case 'failed':
      return <span className={cn(base, 'bg-red-500')} />;
    default:
      return null;
  }
}

// ─── Component ────────────────────────────────────────────────

interface StageNavVerticalProps {
  stages: StageState[];
  activeIndex: number;
  onStageClick: (index: number) => void;
  onExecuteStage?: (index: number) => void;
  onResetStage?: (index: number) => void;
  isExecuting?: boolean;
}

export const StageNavVertical = memo(function StageNavVertical({
  stages,
  activeIndex,
  onStageClick,
  onExecuteStage,
  onResetStage,
  isExecuting = false,
}: StageNavVerticalProps) {
  const handleClick = useCallback(
    (index: number, clickable: boolean) => {
      if (clickable) onStageClick(index);
    },
    [onStageClick],
  );

  const handleCopyOutput = useCallback((stage: StageState) => {
    if (stage.output) {
      navigator.clipboard.writeText(stage.output).catch(() => {});
    }
  }, []);

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Pipeline stages">
      {stages.map((stage, index) => {
        const isActive = index === activeIndex;
        const isClickable = stage.status !== 'locked';
        const Icon = STAGE_ICONS[stage.name] ?? ScanSearch;

        const stageButton = (
          <button
            key={stage.name}
            onClick={() => handleClick(index, isClickable)}
            disabled={!isClickable}
            className={cn(
              'group flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all text-sm w-full',
              isActive
                ? 'bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-300 font-semibold'
                : isClickable
                  ? 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/50'
                  : 'text-slate-400 dark:text-slate-500 cursor-not-allowed',
            )}
            title={`${stage.label} — ${stage.status}`}
          >
            {/* Stage icon with status dot */}
            <span className="relative flex-shrink-0">
              <Icon
                className={cn(
                  'w-4.5 h-4.5',
                  isActive
                    ? 'text-primary-600 dark:text-primary-400'
                    : stage.status === 'locked'
                      ? 'text-slate-400 dark:text-slate-500'
                      : 'text-slate-500 dark:text-slate-400',
                )}
              />
              <StatusDot status={stage.status} />
            </span>

            {/* Label + status text */}
            <span className="flex-1 min-w-0 truncate">{stage.label}</span>

            {/* Lock icon for locked stages */}
            {stage.status === 'locked' && (
              <Lock className="w-3 h-3 text-slate-400 dark:text-slate-500 flex-shrink-0" />
            )}

            {/* Progress when generating */}
            {(stage.status === 'generating' || stage.status === 'validating') && (
              <span className="text-[10px] font-mono text-primary-500">
                {stage.progress}%
              </span>
            )}
          </button>
        );

        return (
          <StageContextMenu
            key={stage.name}
            stage={stage}
            stageIndex={index}
            onExecute={() => onExecuteStage?.(index)}
            onReset={() => onResetStage?.(index)}
            onNavigate={() => onStageClick(index)}
            onCopyOutput={() => handleCopyOutput(stage)}
            isExecuting={isExecuting}
          >
            {stageButton}
          </StageContextMenu>
        );
      })}
    </nav>
  );
});
