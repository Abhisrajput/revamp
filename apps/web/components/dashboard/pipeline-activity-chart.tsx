'use client';

import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';

interface PipelineRun {
  id: string;
  status: string;
  current_stage: string | null;
  started_at?: string;
  created_at: string;
  project?: { id: string; name: string };
}

interface PipelineActivityChartProps {
  runs: PipelineRun[];
}

/**
 * Custom stacked bar chart showing pipeline activity over the last 14 days.
 * No charting library — pure CSS flexbox. Inspired by Paperclip's ActivityCharts.
 */
export const PipelineActivityChart = memo(function PipelineActivityChart({ runs }: PipelineActivityChartProps) {
  const { days, maxCount } = useMemo(() => {
    const now = new Date();
    const dayMap = new Map<string, { completed: number; running: number; failed: number }>();

    // Initialize last 14 days
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayMap.set(key, { completed: 0, running: 0, failed: 0 });
    }

    // Bucket runs by day
    for (const run of runs) {
      const date = (run.started_at || run.created_at || '').slice(0, 10);
      const bucket = dayMap.get(date);
      if (!bucket) continue;
      if (run.status === 'completed') bucket.completed++;
      else if (run.status === 'failed') bucket.failed++;
      else bucket.running++;
    }

    const days = [...dayMap.entries()].map(([date, counts]) => ({
      date,
      label: new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ...counts,
      total: counts.completed + counts.running + counts.failed,
    }));

    const maxCount = Math.max(1, ...days.map(d => d.total));
    return { days, maxCount };
  }, [runs]);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/80 p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Pipeline Activity</h3>
          <p className="text-[10px] text-slate-400 mt-0.5">Last 14 days</p>
        </div>
        <div className="flex items-center gap-3">
          <Legend color="bg-emerald-500" label="Completed" />
          <Legend color="bg-cyan-500" label="Running" />
          <Legend color="bg-red-400" label="Failed" />
        </div>
      </div>

      {/* Chart */}
      <div className="flex items-end gap-1 h-20">
        {days.map((day) => {
          const height = day.total > 0 ? Math.max(4, (day.total / maxCount) * 100) : 0;
          return (
            <div key={day.date} className="flex-1 flex flex-col items-stretch justify-end group relative" style={{ height: '100%' }}>
              {/* Tooltip */}
              <div className="absolute -top-10 left-1/2 -translate-x-1/2 hidden group-hover:block z-10">
                <div className="bg-slate-900 text-white text-[9px] px-2 py-1 rounded shadow-lg whitespace-nowrap">
                  {day.label}: {day.total} run{day.total !== 1 ? 's' : ''}
                </div>
              </div>

              {/* Stacked bar */}
              <div className="flex flex-col-reverse rounded-sm overflow-hidden transition-all duration-300" style={{ height: `${height}%` }}>
                {day.completed > 0 && (
                  <div className="bg-emerald-500 dark:bg-emerald-400" style={{ flex: day.completed }} />
                )}
                {day.running > 0 && (
                  <div className="bg-cyan-500 dark:bg-cyan-400" style={{ flex: day.running }} />
                )}
                {day.failed > 0 && (
                  <div className="bg-red-400 dark:bg-red-500" style={{ flex: day.failed }} />
                )}
              </div>

              {height === 0 && (
                <div className="h-[2px] rounded-full bg-slate-200 dark:bg-slate-700" />
              )}
            </div>
          );
        })}
      </div>

      {/* Date labels */}
      <div className="flex items-center mt-1.5">
        <span className="text-[9px] text-slate-400 flex-1 text-left">{days[0]?.label}</span>
        <span className="text-[9px] text-slate-400 flex-1 text-center">{days[7]?.label}</span>
        <span className="text-[9px] text-slate-400 flex-1 text-right">{days[13]?.label}</span>
      </div>
    </div>
  );
});

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className={cn('w-2 h-2 rounded-full', color)} />
      <span className="text-[9px] text-slate-400">{label}</span>
    </div>
  );
}
