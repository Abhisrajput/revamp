'use client';

/**
 * Agent Bot Grid — renders one TypingBot per planned subtask from the Director.
 * Bots are color-coded by status (running, completed, failed).
 * Falls back to a single centered bot if no subtasks are planned yet.
 */

import { TypingBot } from '@/components/ui/typing-bot';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import type { ScanSubtaskState } from '@/lib/stores/pipeline-store';
import { cn } from '@/lib/utils';

interface AgentBotGridProps {
  subtasks: ScanSubtaskState[];
  message: string;
  subtitle?: string;
  /** Optional overall progress across ALL gap-fill rounds (deduped by title).
   *  When provided, the progress bar uses these counts instead of the visible
   *  `subtasks` array — so adding a fresh gap-fill round doesn't reset the bar. */
  overallProgress?: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    rounds: number;
  };
}

// Convert subtask type to a friendly display name
function formatTitle(s: ScanSubtaskState): string {
  return s.title || s.label || s.type
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function StatusIcon({ status }: { status: ScanSubtaskState['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-500" />;
    case 'running':
      return <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />;
    default:
      return <span className="w-2 h-2 rounded-full bg-slate-400" />;
  }
}

export function AgentBotGrid({ subtasks, message, subtitle, overallProgress }: AgentBotGridProps) {
  // No subtasks yet — show a single big centered bot
  if (!subtasks || subtasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-4">
        <TypingBot size="xl" />
        <div className="text-center">
          <p className="text-base font-semibold text-slate-700 dark:text-slate-200">{message}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
        </div>
      </div>
    );
  }

  // Multiple subtasks — show a grid of smaller bots, one per agent
  const cols = subtasks.length <= 2 ? 2 : subtasks.length <= 4 ? 2 : 3;

  // Progress: prefer overallProgress (covers all gap-fill rounds, deduped) so
  // a fresh round doesn't reset the bar. Fall back to the visible-batch counts
  // when no overall data was provided (e.g. SCAN, or before sync hydrates).
  // Running counts as 0.5 so the bar advances smoothly as subtasks transition.
  const completedCount = overallProgress?.completed
    ?? subtasks.filter((s) => s.status === 'completed').length;
  const runningCount = overallProgress?.running
    ?? subtasks.filter((s) => s.status === 'running').length;
  const failedCount = overallProgress?.failed
    ?? subtasks.filter((s) => s.status === 'failed').length;
  const total = overallProgress?.total ?? subtasks.length;
  const rounds = overallProgress?.rounds ?? 1;
  const progressPct = total > 0
    ? Math.min(100, Math.round(((completedCount + runningCount * 0.5) / total) * 100))
    : 0;

  return (
    <div className="flex flex-col items-center py-6 gap-5 flex-1 min-h-0 overflow-y-auto">
      {/* Header message — sticky so the progress bar stays visible while scrolling */}
      <div className="text-center w-full max-w-md sticky top-0 bg-white dark:bg-slate-950 z-10 pb-2">
        <p className="text-base font-semibold text-slate-700 dark:text-slate-200">{message}</p>
        {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}

        {/* Animated progress bar */}
        <div className="mt-3 px-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">
              {completedCount} / {total} agents complete
              {failedCount > 0 && (
                <span className="ml-1.5 text-red-500">({failedCount} failed)</span>
              )}
              {rounds > 1 && (
                <span className="ml-1.5 text-slate-400">• round {rounds}</span>
              )}
            </span>
            <span className="text-[11px] font-mono text-primary-600 dark:text-primary-400 tabular-nums">
              {progressPct}%
            </span>
          </div>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            {/* Fill: completed + half-credit for running, animates smoothly */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-primary-500 to-primary-400 transition-[width] duration-700 ease-out"
              style={{ width: `${progressPct}%` }}
            />
            {/* Animated shimmer overlay to convey active work while subtasks run */}
            {runningCount > 0 && (
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-transparent via-white/40 to-transparent animate-shimmer"
                style={{ width: `${progressPct}%` }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Grid of bots */}
      <div
        className="grid gap-4 max-w-3xl"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {subtasks.map((subtask) => (
          <div
            key={subtask.id}
            className={cn(
              'flex flex-col items-center gap-2 p-3 rounded-xl border transition-all',
              subtask.status === 'completed' && 'border-green-200 bg-green-50/50 dark:border-green-900/40 dark:bg-green-900/10',
              subtask.status === 'failed' && 'border-red-200 bg-red-50/50 dark:border-red-900/40 dark:bg-red-900/10',
              subtask.status === 'running' && 'border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-900/10',
              (subtask.status === 'pending' || !subtask.status) && 'border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-900/30 opacity-60',
            )}
          >
            <div
              className={cn(
                subtask.status !== 'running' && 'opacity-50 grayscale',
                subtask.status === 'completed' && 'grayscale-0 opacity-100',
              )}
            >
              <TypingBot size="md" centered={false} />
            </div>

            <div className="text-center w-full">
              <div className="flex items-center justify-center gap-1.5 mb-0.5">
                <StatusIcon status={subtask.status} />
                <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                  {formatTitle(subtask)}
                </span>
              </div>
              {subtask.agentName && (
                <p className="text-[9px] text-slate-400 truncate">{subtask.agentName}</p>
              )}
              {subtask.status === 'completed' && subtask.duration && (
                <p className="text-[9px] text-green-600 dark:text-green-400 mt-0.5">
                  {(subtask.duration / 1000).toFixed(1)}s
                </p>
              )}
              {subtask.status === 'failed' && subtask.error && (
                <p className="text-[9px] text-red-500 truncate mt-0.5" title={subtask.error}>
                  {subtask.error.slice(0, 30)}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
