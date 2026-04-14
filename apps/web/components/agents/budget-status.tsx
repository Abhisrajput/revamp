'use client';

import { cn } from '@/lib/utils';
import { useAgentBudgetStatus, useResumeAgent } from '@revamp/core';
import type { AgentPersona } from '@revamp/core';
import { Card } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { Button } from '@revamp/ui/components/button';
import {
  DollarSign, AlertTriangle, XOctagon, TrendingUp, Play,
} from 'lucide-react';

interface BudgetStatusProps {
  agent: AgentPersona;
}

/**
 * Detailed budget view for an agent. Shows current spend, limit, warning threshold,
 * projected spend (linear extrapolation), warning/exceeded badges, and a resume button
 * when the agent is paused due to budget.
 */
export function BudgetStatus({ agent }: BudgetStatusProps) {
  const { data: budget, isLoading } = useAgentBudgetStatus(agent.id);
  const resumeAgent = useResumeAgent();

  // Derive projected spend from days elapsed in the current month
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const spentCents = budget?.spentCents ?? agent.spent_monthly_cents;
  const limitCents = budget?.limitCents ?? agent.monthly_budget_cents ?? 0;
  const projectedCents = dayOfMonth > 0
    ? Math.round((spentCents / dayOfMonth) * daysInMonth)
    : 0;
  const projectedPct = limitCents > 0 ? projectedCents / limitCents : 0;

  const percentUsed = budget?.percentUsed ?? (limitCents > 0 ? spentCents / limitCents : 0);
  const warningAt = budget?.warningAt ?? parseFloat(String(agent.warning_threshold ?? '0.8'));
  const isWarning = budget?.isWarning ?? (percentUsed >= warningAt && percentUsed < 1);
  const isExceeded = budget?.isExceeded ?? (percentUsed >= 1);
  const hardStop = budget?.hardStop ?? agent.hard_stop_enabled ?? false;
  const isPausedForBudget = agent.status === 'paused' && agent.pause_reason === 'budget_exceeded';

  const barColor = isExceeded
    ? 'bg-red-500'
    : isWarning
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  const projectedBarColor = projectedPct >= 1
    ? 'bg-red-300 dark:bg-red-800'
    : projectedPct >= warningAt
      ? 'bg-amber-300 dark:bg-amber-800'
      : 'bg-emerald-300 dark:bg-emerald-800';

  const handleResume = () => {
    resumeAgent.mutate(agent.id);
  };

  if (isLoading) {
    return (
      <Card className="bg-white dark:bg-slate-800 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/4" />
          <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-full" />
          <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-full" />
        </div>
      </Card>
    );
  }

  return (
    <Card className="bg-white dark:bg-slate-800 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            Budget Status
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {isExceeded && (
            <Badge className="bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400">
              <XOctagon className="w-3 h-3 mr-1" />
              Exceeded
            </Badge>
          )}
          {isWarning && !isExceeded && (
            <Badge className="bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3 mr-1" />
              Warning
            </Badge>
          )}
          {hardStop && (
            <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
              Hard Stop
            </Badge>
          )}
        </div>
      </div>

      {/* Paused banner */}
      {isPausedForBudget && (
        <div className="flex items-center justify-between mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2">
            <XOctagon className="w-4 h-4 text-red-500" />
            <span className="text-sm font-medium text-red-700 dark:text-red-400">
              Agent paused — monthly budget exceeded
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleResume}
            disabled={resumeAgent.isPending}
            className="border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/20"
          >
            <Play className="w-3.5 h-3.5 mr-1" />
            {resumeAgent.isPending ? 'Resuming...' : 'Resume Agent'}
          </Button>
        </div>
      )}

      {/* Spend bar */}
      <div className="space-y-1.5 mb-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-600 dark:text-slate-400">
            ${(spentCents / 100).toFixed(2)} spent of ${(limitCents / 100).toFixed(2)} limit
          </span>
          <span className={cn(
            'font-medium',
            isExceeded ? 'text-red-600 dark:text-red-400'
              : isWarning ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-600 dark:text-slate-400',
          )}>
            {(percentUsed * 100).toFixed(1)}%
          </span>
        </div>
        <div className="relative h-3 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
          {/* Actual spend */}
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full transition-all z-10', barColor)}
            style={{ width: `${Math.min(percentUsed * 100, 100)}%` }}
          />
          {/* Warning threshold marker */}
          <div
            className="absolute inset-y-0 w-0.5 bg-amber-600 dark:bg-amber-400 z-20"
            style={{ left: `${warningAt * 100}%` }}
            title={`Warning at ${(warningAt * 100).toFixed(0)}%`}
          />
        </div>
        <div className="flex justify-between text-[10px] text-slate-400 dark:text-slate-500">
          <span>$0</span>
          <span className="text-amber-500 dark:text-amber-400">
            Warning: {(warningAt * 100).toFixed(0)}%
          </span>
          <span>${(limitCents / 100).toFixed(2)}</span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Current Spend</p>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            ${(spentCents / 100).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Monthly Limit</p>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            ${(limitCents / 100).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400">Remaining</p>
          <p className={cn(
            'text-sm font-semibold',
            isExceeded
              ? 'text-red-600 dark:text-red-400'
              : 'text-emerald-600 dark:text-emerald-400',
          )}>
            ${(Math.max(limitCents - spentCents, 0) / 100).toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />
            Projected
          </p>
          <p className={cn(
            'text-sm font-semibold',
            projectedPct >= 1
              ? 'text-red-600 dark:text-red-400'
              : projectedPct >= warningAt
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-slate-900 dark:text-slate-50',
          )}>
            ${(projectedCents / 100).toFixed(2)}
          </p>
        </div>
      </div>

      {/* Projected spend bar */}
      <div className="mt-4 space-y-1">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Projected end-of-month (day {dayOfMonth}/{daysInMonth})
        </p>
        <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', projectedBarColor)}
            style={{ width: `${Math.min(projectedPct * 100, 100)}%` }}
          />
        </div>
        <p className="text-[10px] text-slate-400 dark:text-slate-500">
          {(projectedPct * 100).toFixed(0)}% of limit projected
          {projectedPct >= 1 && ' — on track to exceed'}
        </p>
      </div>
    </Card>
  );
}
