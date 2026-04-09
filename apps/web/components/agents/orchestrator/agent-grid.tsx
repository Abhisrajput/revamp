'use client';

import { cn } from '@/lib/utils';
import { StatusIndicator } from '@/components/agents/status-indicator';
import { Badge } from '@/components/ui/badge';
import { Brain, Hammer, Shield, FileText, Zap, DollarSign, CheckCircle2, XCircle } from 'lucide-react';
import type { AgentOrchestratorState } from '@/lib/hooks/use-orchestrator';

// ─── CONSTANTS ──────────────────────────────────────────────────

const DEPT_META: Record<string, { icon: typeof Brain; color: string; border: string; bg: string }> = {
  discovery: { icon: Brain, color: 'text-purple-400', border: 'border-purple-500/30', bg: 'from-purple-500/5 to-transparent' },
  execution: { icon: Hammer, color: 'text-blue-400', border: 'border-blue-500/30', bg: 'from-blue-500/5 to-transparent' },
  qa: { icon: Shield, color: 'text-emerald-400', border: 'border-emerald-500/30', bg: 'from-emerald-500/5 to-transparent' },
  pm: { icon: FileText, color: 'text-amber-400', border: 'border-amber-500/30', bg: 'from-amber-500/5 to-transparent' },
};

const STATUS_BADGE: Record<string, string> = {
  idle: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  working: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  paused: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  disabled: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
};

// ─── COMPONENT ──────────────────────────────────────────────────

interface AgentGridProps {
  agents: AgentOrchestratorState[];
}

export function AgentGrid({ agents }: AgentGridProps) {
  if (agents.length === 0) {
    return (
      <div className="text-center py-8 text-slate-400 dark:text-slate-500 text-sm">
        No agents loaded. Run the seed script to create agent personas.
      </div>
    );
  }

  // Sort: working first, then by tasksCompleted desc, then idle, then paused/disabled
  const sorted = [...agents].sort((a, b) => {
    const order: Record<string, number> = { working: 0, idle: 1, paused: 2, disabled: 3 };
    const statusDiff = (order[a.status] ?? 4) - (order[b.status] ?? 4);
    if (statusDiff !== 0) return statusDiff;
    return b.tasksCompleted - a.tasksCompleted;
  });

  // Filter out agents with no activity if there are too many
  const hasActivity = sorted.filter(
    (a) => a.status === 'working' || a.tasksCompleted > 0 || (a.tasksFailed ?? 0) > 0 || (a.tokensUsed ?? 0) > 0,
  );
  const noActivity = sorted.filter(
    (a) => a.status !== 'working' && a.tasksCompleted === 0 && (a.tasksFailed ?? 0) === 0 && (a.tokensUsed ?? 0) === 0,
  );

  return (
    <div className="space-y-4">
      {/* Agents with activity */}
      {hasActivity.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {hasActivity.map((agent) => (
            <AgentOrchestratorCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}

      {/* Inactive agents — collapsed */}
      {noActivity.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
            {noActivity.length} idle agents with no recent activity
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 mt-3">
            {noActivity.map((agent) => (
              <AgentOrchestratorCard key={agent.id} agent={agent} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── AGENT CARD ─────────────────────────────────────────────────

function AgentOrchestratorCard({ agent }: { agent: AgentOrchestratorState }) {
  const dept = DEPT_META[agent.department] || DEPT_META.discovery;
  const Icon = dept.icon;
  const isWorking = agent.status === 'working';

  return (
    <div
      className={cn(
        'relative rounded-xl border p-3 transition-all duration-300 overflow-hidden',
        'bg-white dark:bg-slate-800/80',
        isWorking
          ? cn(dept.border, 'shadow-[0_8px_30px_rgba(6,182,212,0.08)]')
          : 'border-slate-200 dark:border-slate-700/50 hover:border-slate-300 dark:hover:border-slate-600',
      )}
    >
      {/* Subtle gradient for working agents */}
      {isWorking && (
        <div
          className={cn('absolute inset-0 bg-gradient-to-br opacity-50', dept.bg)}
        />
      )}

      <div className="relative">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className={cn('w-7 h-7 rounded-md flex items-center justify-center bg-slate-100 dark:bg-slate-700', dept.color)}>
              <Icon className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate leading-tight">
                {agent.name}
              </p>
              <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate">
                {agent.slug}
              </p>
            </div>
          </div>
          <StatusIndicator status={agent.status} size="sm" />
        </div>

        {/* Status & Role */}
        <div className="flex gap-1 mb-2">
          <Badge className={cn('text-[10px] px-1.5 py-0', STATUS_BADGE[agent.status])}>
            {isWorking ? (
              <span className="flex items-center gap-1">
                <span className="relative w-1.5 h-1.5">
                  <span className="absolute inset-0 rounded-full bg-cyan-400 animate-ping opacity-75" />
                  <span className="absolute inset-0 rounded-full bg-cyan-400" />
                </span>
                Live
              </span>
            ) : agent.status}
          </Badge>
          <Badge className="text-[10px] px-1.5 py-0 bg-slate-50 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300">
            {agent.role}
          </Badge>
        </div>

        {/* Current task with typing animation */}
        {isWorking && agent.currentTask && (
          <div className="mb-2">
            <p className="text-[10px] text-slate-500 dark:text-slate-400 mb-1">Current Task:</p>
            <div className="flex items-center gap-1.5">
              <p className="text-[11px] text-slate-700 dark:text-slate-200 truncate">
                {agent.currentTask}
              </p>
              <span className="inline-flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </div>
          </div>
        )}

        {/* Progress bar */}
        {isWorking && (agent.progress ?? 0) > 0 && (
          <div className="mb-2">
            <div className="flex justify-between text-[10px] text-slate-500 dark:text-slate-400 mb-0.5">
              <span>Progress</span>
              <span>{agent.progress ?? 0}%</span>
            </div>
            <div className="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-1000',
                  (agent.progress ?? 0) < 30 ? 'bg-blue-400' :
                  (agent.progress ?? 0) < 70 ? 'bg-primary-500' :
                  'bg-green-500',
                )}
                style={{ width: `${agent.progress ?? 0}%` }}
              />
            </div>
          </div>
        )}

        {/* Real metrics for agents that have done work */}
        {(agent.tasksCompleted > 0 || (agent.tasksFailed ?? 0) > 0 || (agent.tokensUsed ?? 0) > 0) && (
          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-slate-200/50 dark:border-slate-700/30">
            {agent.tasksCompleted > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-green-500">
                <CheckCircle2 className="w-3 h-3" />
                {agent.tasksCompleted}
              </span>
            )}
            {(agent.tasksFailed ?? 0) > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-red-400">
                <XCircle className="w-3 h-3" />
                {agent.tasksFailed}
              </span>
            )}
            {(agent.tokensUsed ?? 0) > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-slate-400">
                <Zap className="w-3 h-3" />
                {(agent.tokensUsed ?? 0) >= 1000
                  ? `${((agent.tokensUsed ?? 0) / 1000).toFixed(1)}K`
                  : agent.tokensUsed}
              </span>
            )}
            {(agent.totalCostCents ?? 0) > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-slate-400">
                <DollarSign className="w-3 h-3" />
                ${((agent.totalCostCents ?? 0) / 100).toFixed(2)}
              </span>
            )}
            {agent.lastActiveAt && (
              <span className="text-[9px] text-slate-400 dark:text-slate-500 ml-auto">
                {formatTimeAgo(agent.lastActiveAt)}
              </span>
            )}
          </div>
        )}

        {/* Idle message */}
        {agent.status === 'idle' && agent.tasksCompleted === 0 && (
          <p className="text-[10px] text-slate-400 dark:text-slate-500 italic">
            Awaiting assignment...
          </p>
        )}

        {agent.status === 'paused' && (
          <p className="text-[10px] text-amber-500 dark:text-amber-400 italic">
            Paused — awaiting review
          </p>
        )}
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────

function formatTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
