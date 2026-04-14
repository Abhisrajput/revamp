

import { useQuery } from '@tanstack/react-query';
import { Card } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { Coins, TrendingUp, Cpu, Zap } from 'lucide-react';
import { getApiClient } from '@revamp/core';

// ─── TYPES ──────────────────────────────────────────────────────

interface ModelUsage {
  model: string;
  count: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

interface ProjectUsageData {
  project_id: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  by_model: ModelUsage[];
}

interface StageUsageData {
  project_id: string;
  stages: Array<{
    stage_name: string;
    stage_index: number;
    total_tokens: number;
    total_cost_usd: number;
    request_count: number;
  }>;
}

// ─── HOOKS ──────────────────────────────────────────────────────

function useProjectUsage(projectId: string) {
  return useQuery<ProjectUsageData>({
    queryKey: ['usage', 'project', projectId],
    queryFn: async () => {
      const res = await getApiClient().get(`/usage/project/${projectId}`);
      return res.data;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

function useStageUsage(projectId: string) {
  return useQuery<StageUsageData>({
    queryKey: ['usage', 'project', projectId, 'stages'],
    queryFn: async () => {
      const res = await getApiClient().get(`/usage/project/${projectId}/stages`);
      return res.data;
    },
    staleTime: 30_000,
    enabled: !!projectId,
  });
}

// ─── HELPERS ────────────────────────────────────────────────────

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return tokens.toString();
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `< $0.01`;
  return `$${cost.toFixed(2)}`;
}

function getProviderColor(model: string): string {
  if (model.startsWith('claude')) return 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400';
  if (model.startsWith('gpt') || model.startsWith('o3')) return 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400';
  if (model.startsWith('gemini')) return 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400';
  return 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
}

function getProviderName(model: string): string {
  if (model.startsWith('claude')) return 'Anthropic';
  if (model.startsWith('gpt') || model.startsWith('o3')) return 'OpenAI';
  if (model.startsWith('gemini')) return 'Google';
  return 'Unknown';
}

// ─── COMPACT FOOTER WIDGET ──────────────────────────────────────

interface TokenUsageFooterProps {
  projectId: string;
}

export function TokenUsageFooter({ projectId }: TokenUsageFooterProps) {
  const { data } = useProjectUsage(projectId);

  if (!data || data.total_requests === 0) return null;

  return (
    <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-700 pt-3 mt-3">
      <span className="flex items-center gap-1">
        <Zap className="w-3 h-3" />
        {formatTokens(data.total_tokens)} tokens
      </span>
      <span className="flex items-center gap-1">
        <Coins className="w-3 h-3" />
        {formatCost(data.total_cost_usd)}
      </span>
      <span className="flex items-center gap-1">
        <Cpu className="w-3 h-3" />
        {data.total_requests} calls
      </span>
      {data.by_model.length > 0 && (
        <Badge className={`${getProviderColor(data.by_model[0].model)} text-[10px] py-0`}>
          {data.by_model[0].model.split('-').slice(0, 2).join('-')}
        </Badge>
      )}
    </div>
  );
}

// ─── FULL TOKEN USAGE PANEL ─────────────────────────────────────

interface TokenUsagePanelProps {
  projectId: string;
}

export function TokenUsagePanel({ projectId }: TokenUsagePanelProps) {
  const { data: usage, isLoading: usageLoading } = useProjectUsage(projectId);
  const { data: stageUsage } = useStageUsage(projectId);

  if (usageLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-24 bg-slate-200 dark:bg-slate-700 rounded-lg" />
        <div className="h-40 bg-slate-200 dark:bg-slate-700 rounded-lg" />
      </div>
    );
  }

  if (!usage || usage.total_requests === 0) {
    return (
      <Card className="bg-white dark:bg-slate-800 p-6">
        <div className="text-center text-slate-500 dark:text-slate-400">
          <Coins className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No LLM usage recorded yet.</p>
          <p className="text-xs mt-1">Run a pipeline stage to see token usage and costs.</p>
        </div>
      </Card>
    );
  }

  // Find the max tokens per stage for the bar chart
  const maxStageTokens = stageUsage
    ? Math.max(...stageUsage.stages.map((s) => s.total_tokens), 1)
    : 1;

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="bg-white dark:bg-slate-800 p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Total Cost
          </p>
          <p className="text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">
            {formatCost(usage.total_cost_usd)}
          </p>
        </Card>

        <Card className="bg-white dark:bg-slate-800 p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Total Tokens
          </p>
          <p className="text-xl font-bold text-slate-900 dark:text-slate-50 mt-1">
            {formatTokens(usage.total_tokens)}
          </p>
        </Card>

        <Card className="bg-white dark:bg-slate-800 p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Input
          </p>
          <p className="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1">
            {formatTokens(usage.total_input_tokens)}
          </p>
        </Card>

        <Card className="bg-white dark:bg-slate-800 p-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
            Output
          </p>
          <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
            {formatTokens(usage.total_output_tokens)}
          </p>
        </Card>
      </div>

      {/* Model Distribution */}
      {usage.by_model.length > 0 && (
        <Card className="bg-white dark:bg-slate-800 p-4">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3 flex items-center gap-2">
            <TrendingUp className="w-4 h-4" />
            Model Distribution
          </h4>
          <div className="space-y-2">
            {usage.by_model.map((model) => {
              const pct = usage.total_tokens > 0
                ? ((model.input_tokens + model.output_tokens) / usage.total_tokens) * 100
                : 0;

              return (
                <div key={model.model} className="flex items-center gap-3">
                  <Badge className={`${getProviderColor(model.model)} text-[10px] min-w-[60px] justify-center`}>
                    {getProviderName(model.model)}
                  </Badge>
                  <div className="flex-1">
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="text-slate-700 dark:text-slate-300 font-mono">
                        {model.model}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {formatTokens(model.input_tokens + model.output_tokens)} · {formatCost(model.cost)}
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
                      <div
                        className="bg-primary-500 h-1.5 rounded-full transition-all"
                        style={{ width: `${Math.max(pct, 1)}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Stage Usage Breakdown */}
      {stageUsage && stageUsage.stages.some((s) => s.total_tokens > 0) && (
        <Card className="bg-white dark:bg-slate-800 p-4">
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Usage by Stage
          </h4>
          <div className="space-y-2">
            {stageUsage.stages.map((stage) => {
              if (stage.total_tokens === 0) return null;
              const pct = (stage.total_tokens / maxStageTokens) * 100;

              return (
                <div key={stage.stage_name} className="flex items-center gap-3">
                  <span className="text-xs font-mono text-slate-600 dark:text-slate-400 min-w-[80px]">
                    {stage.stage_name}
                  </span>
                  <div className="flex-1">
                    <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                      <div
                        className="bg-primary-500 h-2 rounded-full transition-all"
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-xs text-slate-500 dark:text-slate-400 min-w-[60px] text-right">
                    {formatTokens(stage.total_tokens)}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 min-w-[50px] text-right">
                    {formatCost(stage.total_cost_usd)}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

export default TokenUsagePanel;
