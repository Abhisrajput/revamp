'use client';

import { memo, useState } from 'react';
import { Play, Square, SkipForward, RotateCcw, Undo2, CheckCircle, XCircle, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StageState } from '@/lib/stores/pipeline-store';
import { usePipelineStore, canExecuteStage, getStageBlockReason, stageRequiresApproval } from '@/lib/stores/pipeline-store';

// ─── Component ──────────────────────────────────────────────────

interface PipelineActionBarProps {
  stage: StageState;
  isGenerating: boolean;
  onExecute: () => void;
  onStop: () => void;
  onAdvance: () => void;
  onRerun: () => void;
  onReset: () => void;
  onApprove?: (comment?: string) => void;
  onReject?: (reason: string) => void;
  isLastStage: boolean;
  className?: string;
}

export const PipelineActionBar = memo(function PipelineActionBar({
  stage,
  isGenerating,
  onExecute,
  onStop,
  onAdvance,
  onRerun,
  onReset,
  onApprove,
  onReject,
  isLastStage,
  className,
}: PipelineActionBarProps) {
  // Use guardrail to check prerequisites — read current stages from store
  const stages = usePipelineStore((s) => s.stages);
  const activeStageIndex = usePipelineStore((s) => s.activeStageIndex);
  const stageExecutable = canExecuteStage(stages, activeStageIndex);
  const blockReason = getStageBlockReason(stages, activeStageIndex);

  const [rejectReason, setRejectReason] = useState('');
  const [showRejectInput, setShowRejectInput] = useState(false);

  const needsApproval = stageRequiresApproval(stage.name) && stage.approvalStatus === 'pending';

  const canExecute =
    stageExecutable &&
    (stage.status === 'pending' || stage.status === 'failed');

  const canAdvance =
    (stage.status === 'completed' || stage.status === 'approved') &&
    !isLastStage;

  // Re-run only allowed if prerequisites are met
  const canRerun =
    stageExecutable &&
    (stage.status === 'completed' ||
    stage.status === 'approved' ||
    stage.status === 'failed');

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        Actions
      </div>

      <div className="flex flex-col gap-1.5">
        {/* Approval Gate — shown when stage requires approval before execution */}
        {needsApproval && !isGenerating && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800">
              <ShieldCheck className="w-4 h-4 text-amber-500 shrink-0" />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Approval required before execution
              </p>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={() => onApprove?.()}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer',
                  'bg-green-600 hover:bg-green-700 text-white transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-green-500/20',
                )}
              >
                <CheckCircle className="w-3.5 h-3.5" />
                Approve
              </button>
              <button
                onClick={() => setShowRejectInput(!showRejectInput)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium cursor-pointer',
                  'bg-red-600 hover:bg-red-700 text-white transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-red-500/20',
                )}
              >
                <XCircle className="w-3.5 h-3.5" />
                Reject
              </button>
            </div>
            {showRejectInput && (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason for rejection..."
                  className="flex-1 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1.5 text-slate-900 dark:text-slate-50 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-red-500"
                />
                <button
                  onClick={() => {
                    if (rejectReason.trim()) {
                      onReject?.(rejectReason.trim());
                      setRejectReason('');
                      setShowRejectInput(false);
                    }
                  }}
                  disabled={!rejectReason.trim()}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
                    rejectReason.trim()
                      ? 'bg-red-600 hover:bg-red-700 text-white'
                      : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed',
                  )}
                >
                  Send
                </button>
              </div>
            )}
          </div>
        )}

        {/* Execute / Stop */}
        {isGenerating ? (
          <button
            onClick={onStop}
            className={cn(
              'flex items-center justify-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium cursor-pointer',
              'bg-red-600 hover:bg-red-700 text-white transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-red-500/20',
            )}
          >
            <Square className="w-3.5 h-3.5" />
            Stop
          </button>
        ) : (
          <div className="w-full">
            <button
              onClick={onExecute}
              disabled={!canExecute}
              className={cn(
                'flex items-center justify-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium',
                'transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                canExecute
                  ? 'bg-primary-600 hover:bg-primary-700 text-white cursor-pointer'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed',
              )}
            >
              <Play className="w-3.5 h-3.5" />
              Execute Stage
            </button>
            {!canExecute && blockReason && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 text-center">
                {blockReason}
              </p>
            )}
          </div>
        )}

        {/* Advance / Rerun row */}
        <div className="flex gap-1.5">
          {canAdvance && (
            <button
              onClick={onAdvance}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium cursor-pointer',
                'bg-green-600 hover:bg-green-700 text-white transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-green-500/20',
              )}
            >
              <SkipForward className="w-3 h-3" />
              Advance
            </button>
          )}

          {canRerun && !isGenerating && (
            <button
              onClick={onRerun}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium cursor-pointer',
                'border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-300',
                'hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
              )}
            >
              <RotateCcw className="w-3 h-3" />
              Re-run
            </button>
          )}
        </div>

        {/* Reset */}
        {canRerun && !isGenerating && (
          <button
            onClick={onReset}
            className={cn(
              'flex items-center justify-center gap-1.5 w-full rounded-lg px-2 py-1 text-[10px] font-medium cursor-pointer',
              'text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400',
              'hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors',
              'focus:outline-none',
            )}
          >
            <Undo2 className="w-2.5 h-2.5" />
            Reset Stage
          </button>
        )}
      </div>
    </div>
  );
});
