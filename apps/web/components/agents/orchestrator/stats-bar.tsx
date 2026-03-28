'use client';

import { Activity, CheckCircle2, Clock, Cpu, Zap, DollarSign, Braces } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OrchestratorStats, ActivityPeriod } from '@/lib/hooks/use-orchestrator';

// ─── PERIOD OPTIONS ─────────────────────────────────────────────

const PERIOD_OPTIONS: { value: ActivityPeriod; label: string }[] = [
  { value: '1h', label: '1H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
];

// ─── COMPONENT ──────────────────────────────────────────────────

interface StatsBarProps {
  stats: OrchestratorStats;
  period: ActivityPeriod;
  onPeriodChange: (period: ActivityPeriod) => void;
}

export function StatsBar({ stats, period, onPeriodChange }: StatsBarProps) {
  return (
    <div className="space-y-2">
      {/* Period selector + summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex gap-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onPeriodChange(opt.value)}
                className={cn(
                  'px-3 py-1 text-xs font-semibold rounded-md transition-colors',
                  period === opt.value
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-400 dark:text-slate-500 font-medium">
            {stats.periodLabel}
          </span>
        </div>
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          {stats.totalLLMCalls > 0 ? `${stats.totalLLMCalls} LLM calls` : 'No LLM calls yet'}
        </span>
      </div>

      <div className="grid grid-cols-3 lg:grid-cols-7 gap-3">
        <StatCard
          icon={Activity}
          label="Active Agents"
          value={`${stats.activeAgents}/${stats.totalAgents}`}
          color="text-blue-500"
        />
        <StatCard
          icon={CheckCircle2}
          label="Completed"
          value={String(stats.tasksCompleted)}
          color="text-green-500"
        />
        <StatCard
          icon={Clock}
          label="In Progress"
          value={String(stats.tasksQueued)}
          color="text-amber-500"
        />
        <StatCard
          icon={Cpu}
          label="Uptime"
          value={formatRuntime(stats.runtimeSeconds)}
          color="text-purple-500"
        />
        <StatCard
          icon={Zap}
          label="Tokens"
          value={formatTokens(stats.totalTokens)}
          color="text-cyan-500"
        />
        <StatCard
          icon={DollarSign}
          label="Cost"
          value={`$${(stats.totalCostCents / 100).toFixed(2)}`}
          color="text-emerald-500"
        />
        <StatCard
          icon={Braces}
          label="LLM Calls"
          value={formatCount(stats.totalLLMCalls)}
          color="text-orange-500"
        />
      </div>
    </div>
  );
}

// ─── STAT CARD ──────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/50">
      <Icon className={`w-4 h-4 flex-shrink-0 ${color}`} />
      <div className="min-w-0">
        <p className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wide leading-tight">
          {label}
        </p>
        <p className="text-sm font-bold text-slate-900 dark:text-slate-100 tabular-nums truncate">
          {value}
        </p>
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────

function formatRuntime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatCount(count: number): string {
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}
