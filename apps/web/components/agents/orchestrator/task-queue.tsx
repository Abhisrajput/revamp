'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Clock, ArrowUpCircle, CheckCircle2, XCircle, Loader2, Zap, DollarSign } from 'lucide-react';
import type { TaskQueueItem } from '@/lib/hooks/use-orchestrator';

// ─── CONSTANTS ──────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800',
  high: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  normal: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  low: 'bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700',
};

const STATUS_ICONS: Record<string, typeof Clock> = {
  queued: Clock,
  dispatching: Loader2,
  in_progress: ArrowUpCircle,
  completed: CheckCircle2,
  failed: XCircle,
};

const STATUS_TEXT: Record<string, string> = {
  queued: 'Queued',
  dispatching: 'Dispatching...',
  in_progress: 'In Progress',
  completed: 'Completed',
  failed: 'Failed',
};

// ─── COMPONENT ──────────────────────────────────────────────────

interface TaskQueueProps {
  tasks: TaskQueueItem[];
}

export function TaskQueue({ tasks }: TaskQueueProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
        <Clock className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-xs">No tasks in queue</p>
        <p className="text-[10px] mt-1 opacity-70">Tasks appear here when agents receive assignments</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {tasks.map((task, idx) => {
        const Icon = STATUS_ICONS[task.status] || Clock;
        const isActive = task.status === 'in_progress' || task.status === 'dispatching';

        return (
          <div
            key={task.id}
            className={cn(
              'p-3 rounded-lg border transition-all',
              isActive
                ? 'border-primary-300 dark:border-primary-700 bg-primary-50/50 dark:bg-primary-900/10'
                : 'border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50',
              task.status === 'completed' && 'opacity-60',
              task.status === 'failed' && 'border-red-200 dark:border-red-800/50',
            )}
            style={{
              animationDelay: `${idx * 50}ms`,
            }}
          >
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <Icon
                  className={cn(
                    'w-3.5 h-3.5 flex-shrink-0',
                    task.status === 'dispatching' && 'animate-spin text-primary-500',
                    task.status === 'in_progress' && 'text-blue-500',
                    task.status === 'completed' && 'text-green-500',
                    task.status === 'failed' && 'text-red-500',
                    task.status === 'queued' && 'text-slate-400',
                  )}
                />
                <span className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                  {task.title}
                </span>
              </div>
              <Badge className={cn('text-[10px] px-1.5 py-0 flex-shrink-0', PRIORITY_COLORS[task.priority])}>
                {task.priority}
              </Badge>
            </div>

            <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400">
              <span className="font-mono">{task.stage}</span>
              <span>{STATUS_TEXT[task.status]}</span>
            </div>

            {/* Progress bar for active tasks */}
            {isActive && (task.progress ?? 0) > 0 && (
              <div className="mt-2 h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 rounded-full transition-all duration-500"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
            )}

            {/* Agent + metrics row */}
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {task.assignedAgent && (
                <p className="text-[10px] text-slate-400 dark:text-slate-500 truncate">
                  Agent: {task.assignedAgent.name}
                </p>
              )}
              {(task.tokensUsed != null && task.tokensUsed > 0) && (
                <span className="flex items-center gap-0.5 text-[10px] text-slate-400">
                  <Zap className="w-2.5 h-2.5" />
                  {task.tokensUsed >= 1000
                    ? `${(task.tokensUsed / 1000).toFixed(1)}K`
                    : task.tokensUsed}
                </span>
              )}
              {(task.costCents != null && task.costCents > 0) && (
                <span className="flex items-center gap-0.5 text-[10px] text-slate-400">
                  <DollarSign className="w-2.5 h-2.5" />
                  {(task.costCents / 100).toFixed(3)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
