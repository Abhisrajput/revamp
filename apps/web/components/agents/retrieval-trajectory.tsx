'use client';

import { useRetrievalTrajectories } from '@revamp/core';
import type { RetrievalTrajectory, RetrievalStep } from '@revamp/core';
import { Card } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { Route, Clock, Layers } from 'lucide-react';

const TIER_COLORS: Record<string, string> = {
  L0: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
  L1: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  L2: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
};

const REASON_LABELS: Record<string, string> = {
  recent_stage: 'Recent',
  high_relevance: 'Relevant',
  budget_overflow: 'Budget cap',
  skipped_irrelevant: 'Skipped',
  compaction_threshold: 'Compacted',
};

function TokenBudgetBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-400 tabular-nums whitespace-nowrap">
        {used.toLocaleString()} / {total.toLocaleString()}
      </span>
    </div>
  );
}

function StepRow({ step }: { step: RetrievalStep }) {
  const isSkipped = step.reason === 'skipped_irrelevant';

  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded ${isSkipped ? 'opacity-50' : ''}`}>
      <Badge className={`${TIER_COLORS[step.tierLoaded]} text-[10px] px-1.5 py-0 font-mono`}>
        {step.tierLoaded}
      </Badge>
      <span className="text-xs font-mono text-slate-700 dark:text-slate-300 flex-1 truncate">
        {step.sourceStage}
      </span>
      <span className="text-[10px] text-slate-400 tabular-nums">
        {step.tokensConsumed.toLocaleString()} tok
      </span>
      <span className="text-[10px] text-slate-400">
        {REASON_LABELS[step.reason] || step.reason}
      </span>
    </div>
  );
}

function TrajectoryCard({ trajectory }: { trajectory: RetrievalTrajectory }) {
  return (
    <div className="px-3 py-3 rounded-lg border border-slate-100 dark:border-slate-700/50">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Layers className="w-3 h-3 text-slate-400" />
          <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
            {trajectory.stageName}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          {trajectory.evolutionMemoriesLoaded > 0 && (
            <span className="text-amber-500">
              {trajectory.evolutionMemoriesLoaded} memories
            </span>
          )}
          <div className="flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            <span className="tabular-nums">{trajectory.buildDurationMs}ms</span>
          </div>
        </div>
      </div>

      <TokenBudgetBar used={trajectory.tokensUsed} total={trajectory.totalTokenBudget} />

      {trajectory.trajectory.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {trajectory.trajectory.map((step, i) => (
            <StepRow key={`${step.sourceStage}-${i}`} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

export function RetrievalTrajectoryPanel({ pipelineRunId }: { pipelineRunId: string }) {
  const { data: trajectories, isLoading } = useRetrievalTrajectories(pipelineRunId);

  return (
    <Card className="bg-white dark:bg-slate-800 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Route className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          Context Retrieval
        </h3>
        {trajectories && (
          <span className="text-xs text-slate-400 tabular-nums">
            ({trajectories.length} stages)
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-24 bg-slate-100 dark:bg-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : trajectories && trajectories.length > 0 ? (
        <div className="space-y-2 max-h-[500px] overflow-y-auto">
          {trajectories.map((t) => (
            <TrajectoryCard key={t.id} trajectory={t} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400 dark:text-slate-500 text-center py-6">
          No retrieval trajectories recorded yet.
        </p>
      )}
    </Card>
  );
}
