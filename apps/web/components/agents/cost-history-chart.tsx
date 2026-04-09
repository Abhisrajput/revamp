'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import type { CostEvent } from '@/lib/hooks/use-agents';
import { BarChart3 } from 'lucide-react';

interface CostHistoryChartProps {
  costs: CostEvent[];
  className?: string;
}

/**
 * CSS-only bar chart showing daily costs over the last 30 days.
 * No chart library needed — uses flexbox and percentage-height bars.
 */
export function CostHistoryChart({ costs, className }: CostHistoryChartProps) {
  const dailyData = useMemo(() => {
    const now = new Date();
    const days: Array<{ date: string; label: string; totalCents: number }> = [];

    // Build 30-day buckets
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      days.push({
        date: dateStr,
        label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        totalCents: 0,
      });
    }

    // Aggregate costs into day buckets
    for (const cost of costs) {
      const costDate = cost.created_at.split('T')[0];
      const bucket = days.find((d) => d.date === costDate);
      if (bucket) {
        bucket.totalCents += cost.cost_cents ?? 0;
      }
    }

    return days;
  }, [costs]);

  const maxCents = Math.max(...dailyData.map((d) => d.totalCents), 1);
  const totalCents = dailyData.reduce((sum, d) => sum + d.totalCents, 0);
  const avgCents = Math.round(totalCents / 30);
  const daysWithSpend = dailyData.filter((d) => d.totalCents > 0).length;

  return (
    <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            Cost History
          </h2>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span>
            Total: <span className="font-semibold text-slate-900 dark:text-slate-100">${(totalCents / 100).toFixed(2)}</span>
          </span>
          <span>
            Avg/day: <span className="font-semibold text-slate-900 dark:text-slate-100">${(avgCents / 100).toFixed(2)}</span>
          </span>
          <span>
            Active days: <span className="font-semibold text-slate-900 dark:text-slate-100">{daysWithSpend}</span>
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="flex items-end gap-[2px] h-32">
        {dailyData.map((day) => {
          const heightPct = maxCents > 0 ? (day.totalCents / maxCents) * 100 : 0;
          const isToday = day.date === new Date().toISOString().split('T')[0];

          return (
            <div
              key={day.date}
              className="flex-1 flex flex-col items-center justify-end h-full group relative"
            >
              {/* Tooltip */}
              <div className="absolute bottom-full mb-2 hidden group-hover:block z-10">
                <div className="bg-slate-900 dark:bg-slate-700 text-white text-[10px] px-2 py-1 rounded shadow-lg whitespace-nowrap">
                  <p className="font-medium">{day.label}</p>
                  <p>${(day.totalCents / 100).toFixed(4)}</p>
                </div>
              </div>

              {/* Bar */}
              <div
                className={cn(
                  'w-full rounded-t-sm transition-all hover:opacity-80',
                  day.totalCents > 0
                    ? isToday
                      ? 'bg-primary-500'
                      : 'bg-primary-400/70 dark:bg-primary-500/50'
                    : 'bg-slate-200 dark:bg-slate-700',
                )}
                style={{
                  height: day.totalCents > 0 ? `${Math.max(heightPct, 3)}%` : '2px',
                  minHeight: day.totalCents > 0 ? '3px' : '1px',
                }}
              />
            </div>
          );
        })}
      </div>

      {/* X-axis labels (show every 5th day) */}
      <div className="flex items-center gap-[2px] mt-1">
        {dailyData.map((day, i) => (
          <div key={day.date} className="flex-1 text-center">
            {i % 7 === 0 && (
              <span className="text-[9px] text-slate-400 dark:text-slate-500">
                {day.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
