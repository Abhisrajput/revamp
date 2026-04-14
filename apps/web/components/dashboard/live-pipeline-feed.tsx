'use client';

import { memo } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ChevronRight, Play, CheckCircle, XCircle, Clock } from 'lucide-react';
import { PIPELINE_STAGE_ORDER, STAGE_DISPLAY_LABELS } from '@revamp/shared-types';

interface PipelineRun {
  id: string;
  project_id?: string;
  status: string;
  current_stage: string | null;
  started_at?: string;
  created_at: string;
  project?: { id: string; name: string };
}

const STAGE_ORDER = PIPELINE_STAGE_ORDER;
const STAGE_LABELS: Record<string, string> = {
  ...STAGE_DISPLAY_LABELS,
  SCAN: 'Setup & Configuration', BLUEPRINT: 'Business Capability Mining',
  FORGE: 'Co-Create', SHADOW_RUN: 'Parallel Run & Cutover',
};

interface LivePipelineFeedProps {
  runs: PipelineRun[];
}

export const LivePipelineFeed = memo(function LivePipelineFeed({ runs }: LivePipelineFeedProps) {
  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/80 p-6">
        <div className="text-center py-6">
          <Clock className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No pipeline runs yet</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/80 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Recent Pipeline Runs</h3>
      </div>

      <div className="divide-y divide-slate-100 dark:divide-slate-700/30">
        {runs.slice(0, 8).map((run, i) => {
          const stageIdx = (STAGE_ORDER as readonly string[]).indexOf(run.current_stage || 'SCAN');
          const stagesComplete = Math.max(0, stageIdx);
          const isActive = run.status === 'running';
          const isFailed = run.status === 'failed';
          const isComplete = run.status === 'completed';

          const StatusIcon = isComplete ? CheckCircle : isFailed ? XCircle : Play;
          const statusColor = isComplete ? 'text-emerald-500' : isFailed ? 'text-red-500' : 'text-cyan-500';

          return (
            <Link
              key={run.id}
              href={`/projects/${run.project_id || run.project?.id}/runs/${run.id}`}
              target="_blank"
              className={cn(
                'flex items-center gap-4 px-5 py-3 transition-all duration-200 group cursor-pointer',
                'hover:bg-slate-50 dark:hover:bg-slate-700/30',
                // Animate new entries
                i === 0 && isActive && 'animate-[slideIn_0.5s_ease-out]',
              )}
            >
              {/* Status icon with pulse for active */}
              <div className="relative shrink-0">
                <StatusIcon className={cn('w-4.5 h-4.5', statusColor)} />
                {isActive && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-cyan-400 rounded-full">
                    <span className="absolute inset-0 rounded-full bg-cyan-400 animate-ping opacity-75" />
                  </span>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-200 group-hover:text-primary-600 dark:group-hover:text-primary-400 transition-colors truncate">
                    {run.project?.name || 'Unknown Project'}
                  </span>
                  <Badge className={cn('text-[9px] px-1.5 py-0 shrink-0',
                    isComplete ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                      : isFailed ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                      : 'bg-cyan-100 dark:bg-cyan-900/20 text-cyan-700 dark:text-cyan-400',
                  )}>
                    {isComplete ? 'completed' : isFailed ? 'failed' : `${stagesComplete}/8`}
                  </Badge>
                </div>
                {/* Stage progress bar */}
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="flex-1 flex gap-0.5">
                    {STAGE_ORDER.map((stage, si) => (
                      <div
                        key={stage}
                        className={cn(
                          'h-1 flex-1 rounded-full transition-all duration-500',
                          si < stagesComplete ? 'bg-emerald-400 dark:bg-emerald-500'
                            : si === stagesComplete && isActive ? 'bg-cyan-400 dark:bg-cyan-500 animate-pulse'
                            : 'bg-slate-200 dark:bg-slate-700',
                        )}
                        title={STAGE_LABELS[stage]}
                      />
                    ))}
                  </div>
                  <span className="text-[9px] text-slate-400 shrink-0 tabular-nums w-16 text-right">
                    {new Date(run.started_at || run.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              </div>

              <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 group-hover:text-primary-500 transition-colors shrink-0" />
            </Link>
          );
        })}
      </div>
    </div>
  );
});
