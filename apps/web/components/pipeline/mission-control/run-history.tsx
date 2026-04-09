'use client';

import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface PipelineRun {
  id: string;
  project_id: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  current_stage: number;
  stages_completed: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  triggered_by: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const statusConfig = {
  running: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100 dark:bg-blue-900/30', spin: true },
  completed: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-100 dark:bg-green-900/30', spin: false },
  failed: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/30', spin: false },
  paused: { icon: Clock, color: 'text-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30', spin: false },
};

// ─── Component ──────────────────────────────────────────────────

interface RunHistoryProps {
  projectId: string;
  currentRunId: string | null;
  onSelectRun?: (runId: string) => void;
  className?: string;
}

export const RunHistory = memo(function RunHistory({
  projectId,
  currentRunId,
  onSelectRun: _onSelectRun,
  className,
}: RunHistoryProps) {
  const { data: runs, isLoading } = useQuery<PipelineRun[]>({
    queryKey: ['pipeline-runs', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/pipeline/runs?project_id=${projectId}`);
      return res.data?.runs ?? res.data ?? [];
    },
    staleTime: 10_000,
    enabled: !!projectId,
  });

  if (isLoading) {
    return (
      <div className={cn('p-4 space-y-2', className)}>
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 bg-slate-200 dark:bg-slate-700 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center py-8 text-slate-400 dark:text-slate-500', className)}>
        <Clock className="w-6 h-6 mb-2 opacity-50" />
        <p className="text-xs">No pipeline runs yet</p>
      </div>
    );
  }

  return (
    <div className={cn('overflow-auto', className)}>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-200 dark:border-slate-700">
            <th className="text-left px-3 py-2 font-medium">Run</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
            <th className="text-left px-3 py-2 font-medium">Stages</th>
            <th className="text-left px-3 py-2 font-medium">Duration</th>
            <th className="text-left px-3 py-2 font-medium">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const isCurrent = run.id === currentRunId;
            const cfg = statusConfig[run.status] ?? statusConfig.paused;
            const Icon = cfg.icon;

            return (
              <tr
                key={run.id}
                onClick={() => window.open(`/projects/${projectId}/runs/${run.id}`, '_blank')}
                className={cn(
                  'border-b border-slate-100 dark:border-slate-700/50 cursor-pointer transition-colors',
                  isCurrent
                    ? 'bg-primary-50 dark:bg-primary-950/30'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
              >
                <td className="px-3 py-2">
                  <span className="font-mono text-slate-600 dark:text-slate-300">
                    {run.id.slice(0, 7)}
                  </span>
                  {isCurrent && (
                    <span className="ml-1 text-[9px] text-primary-600 dark:text-primary-400 font-medium">
                      current
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={cn('inline-flex items-center gap-1', cfg.color)}>
                    <Icon className={cn('w-3 h-3', cfg.spin && 'animate-spin')} />
                    {run.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                  {run.stages_completed}/8
                </td>
                <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                  {formatDuration(run.duration_ms)}
                </td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                  {formatTimestamp(run.started_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
