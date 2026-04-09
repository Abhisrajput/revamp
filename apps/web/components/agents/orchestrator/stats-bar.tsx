'use client';

import { Activity, CheckCircle2, Clock, Cpu, Zap, DollarSign, Braces, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OrchestratorStats, ActivityPeriod } from '@/lib/hooks/use-orchestrator';

const PERIOD_OPTIONS: { value: ActivityPeriod; label: string }[] = [
  { value: '1h', label: '1H' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
];

interface StatsBarProps {
  stats: OrchestratorStats;
  period: ActivityPeriod;
  onPeriodChange: (period: ActivityPeriod) => void;
}

export function StatsBar({ stats, period, onPeriodChange }: StatsBarProps) {
  const successRate = stats.tasksCompleted + stats.tasksFailed > 0
    ? Math.round((stats.tasksCompleted / (stats.tasksCompleted + stats.tasksFailed)) * 100)
    : 100;

  return (
    <div className="space-y-3">
      {/* Period selector */}
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
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-400 font-medium">{stats.periodLabel}</span>
        </div>
        {stats.escalations > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
            <AlertTriangle className="w-3 h-3 text-amber-500" />
            <span className="text-[10px] font-medium text-amber-700 dark:text-amber-400">{stats.escalations} escalations</span>
          </div>
        )}
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        <MetricTile
          icon={Activity} label="Active" value={`${stats.activeAgents}/${stats.totalAgents}`}
          color="cyan" pulse={stats.activeAgents > 0}
        />
        <MetricTile
          icon={CheckCircle2} label="Completed" value={String(stats.tasksCompleted)}
          color="emerald" subtitle={`${successRate}% success`}
        />
        <MetricTile
          icon={Clock} label="Queued" value={String(stats.tasksQueued ?? 0)}
          color="amber"
        />
        <MetricTile
          icon={Cpu} label="Uptime" value={formatRuntime(stats.runtimeSeconds ?? 0)}
          color="purple"
        />
        <MetricTile
          icon={Zap} label="Tokens" value={formatTokens(stats.totalTokens ?? 0)}
          color="blue"
        />
        <MetricTile
          icon={DollarSign} label="Cost" value={`$${(stats.totalCostCents / 100).toFixed(2)}`}
          color="green"
        />
        <MetricTile
          icon={Braces} label="LLM Calls" value={formatCount(stats.totalLLMCalls ?? 0)}
          color="orange"
        />
      </div>
    </div>
  );
}

// ─── METRIC TILE (elevated, with glow) ─────────────────────────

const TILE_COLORS: Record<string, { icon: string; glow: string; bg: string; pulse: string }> = {
  cyan:    { icon: 'text-cyan-500',    glow: 'shadow-[0_4px_20px_rgba(6,182,212,0.06)]',   bg: 'bg-cyan-50 dark:bg-cyan-950/20',       pulse: 'bg-cyan-400' },
  emerald: { icon: 'text-emerald-500', glow: 'shadow-[0_4px_20px_rgba(16,185,129,0.06)]',  bg: 'bg-emerald-50 dark:bg-emerald-950/20', pulse: 'bg-emerald-400' },
  amber:   { icon: 'text-amber-500',   glow: 'shadow-[0_4px_20px_rgba(245,158,11,0.06)]',  bg: 'bg-amber-50 dark:bg-amber-950/20',     pulse: 'bg-amber-400' },
  purple:  { icon: 'text-purple-500',  glow: 'shadow-[0_4px_20px_rgba(168,85,247,0.06)]',  bg: 'bg-purple-50 dark:bg-purple-950/20',   pulse: 'bg-purple-400' },
  blue:    { icon: 'text-blue-500',    glow: 'shadow-[0_4px_20px_rgba(59,130,246,0.06)]',  bg: 'bg-blue-50 dark:bg-blue-950/20',       pulse: 'bg-blue-400' },
  green:   { icon: 'text-green-500',   glow: 'shadow-[0_4px_20px_rgba(34,197,94,0.06)]',   bg: 'bg-green-50 dark:bg-green-950/20',     pulse: 'bg-green-400' },
  orange:  { icon: 'text-orange-500',  glow: 'shadow-[0_4px_20px_rgba(249,115,22,0.06)]',  bg: 'bg-orange-50 dark:bg-orange-950/20',   pulse: 'bg-orange-400' },
};

function MetricTile({ icon: Icon, label, value, color, subtitle, pulse }: {
  icon: typeof Activity; label: string; value: string; color: string; subtitle?: string; pulse?: boolean;
}) {
  const c = TILE_COLORS[color] || TILE_COLORS.cyan;
  return (
    <div className={cn(
      'relative overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700/50 p-3',
      'bg-white dark:bg-slate-800/80 transition-all duration-300 hover:scale-[1.02]',
      c.glow,
    )}>
      <div className="flex items-center gap-2">
        <div className={cn('p-1.5 rounded-md', c.bg)}>
          <div className="relative">
            <Icon className={cn('w-3.5 h-3.5', c.icon)} />
            {pulse && (
              <span className={cn('absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full', c.pulse)}>
                <span className={cn('absolute inset-0 rounded-full animate-ping opacity-75', c.pulse)} />
              </span>
            )}
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-[9px] text-slate-400 uppercase tracking-wider">{label}</p>
          <p className="text-sm font-bold text-slate-900 dark:text-slate-100 tabular-nums">{value}</p>
          {subtitle && <p className="text-[9px] text-slate-400">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

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
