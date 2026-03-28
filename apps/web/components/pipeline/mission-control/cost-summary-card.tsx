'use client';

import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Zap, Coins, Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface ProjectUsageData {
  project_id: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: Array<{
    model: string;
    count: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  }>;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '< $0.01';
  return `$${cost.toFixed(2)}`;
}

// ─── Component ──────────────────────────────────────────────────

interface CostSummaryCardProps {
  projectId: string;
  className?: string;
}

export const CostSummaryCard = memo(function CostSummaryCard({
  projectId,
  className,
}: CostSummaryCardProps) {
  const { data } = useQuery<ProjectUsageData>({
    queryKey: ['usage', 'project', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/usage/project/${projectId}`);
      return res.data;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });

  if (!data || data.total_requests === 0) {
    return (
      <div className={cn('space-y-1.5', className)}>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Coins className="w-3 h-3" />
          Cost
        </div>
        <p className="text-[10px] text-slate-400 dark:text-slate-500 italic">
          No usage yet
        </p>
      </div>
    );
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      {/* Section Header */}
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <Coins className="w-3 h-3" />
        Cost
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-1">
        <div className="rounded-md bg-slate-50 dark:bg-slate-700/50 px-2 py-1.5 text-center">
          <div className="flex items-center justify-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
            <Zap className="w-2.5 h-2.5" />
            Tokens
          </div>
          <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
            {formatTokens(data.total_tokens)}
          </p>
        </div>

        <div className="rounded-md bg-slate-50 dark:bg-slate-700/50 px-2 py-1.5 text-center">
          <div className="flex items-center justify-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
            <Coins className="w-2.5 h-2.5" />
            Cost
          </div>
          <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
            {formatCost(data.total_cost_usd)}
          </p>
        </div>

        <div className="rounded-md bg-slate-50 dark:bg-slate-700/50 px-2 py-1.5 text-center">
          <div className="flex items-center justify-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
            <Cpu className="w-2.5 h-2.5" />
            Calls
          </div>
          <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
            {data.total_requests}
          </p>
        </div>
      </div>

      {/* Input / Output breakdown bar */}
      {data.total_tokens > 0 && (
        <div className="space-y-0.5">
          <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden flex">
            <div
              className="bg-blue-500 h-full transition-all"
              style={{ width: `${(data.total_input_tokens / data.total_tokens) * 100}%` }}
              title={`Input: ${formatTokens(data.total_input_tokens)}`}
            />
            <div
              className="bg-emerald-500 h-full transition-all"
              style={{ width: `${(data.total_output_tokens / data.total_tokens) * 100}%` }}
              title={`Output: ${formatTokens(data.total_output_tokens)}`}
            />
          </div>
          <div className="flex justify-between text-[9px] text-slate-400 dark:text-slate-500">
            <span>In: {formatTokens(data.total_input_tokens)}</span>
            <span>Out: {formatTokens(data.total_output_tokens)}</span>
          </div>
        </div>
      )}
    </div>
  );
});
