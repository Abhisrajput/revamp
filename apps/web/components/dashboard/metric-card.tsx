'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  trend?: { value: number; label: string };  // positive = up, negative = down
  color?: 'primary' | 'emerald' | 'amber' | 'red' | 'cyan';
  pulse?: boolean;  // animated pulse for live metrics
}

const COLOR_MAP = {
  primary: {
    icon: 'text-primary-500',
    value: 'text-primary-600 dark:text-primary-400',
    bg: 'bg-primary-50 dark:bg-primary-950/30',
    ring: 'ring-primary-200 dark:ring-primary-800',
    glow: 'shadow-[0_8px_30px_rgba(99,102,241,0.08)]',
  },
  emerald: {
    icon: 'text-emerald-500',
    value: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    ring: 'ring-emerald-200 dark:ring-emerald-800',
    glow: 'shadow-[0_8px_30px_rgba(16,185,129,0.08)]',
  },
  amber: {
    icon: 'text-amber-500',
    value: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    ring: 'ring-amber-200 dark:ring-amber-800',
    glow: 'shadow-[0_8px_30px_rgba(245,158,11,0.08)]',
  },
  red: {
    icon: 'text-red-500',
    value: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-50 dark:bg-red-950/30',
    ring: 'ring-red-200 dark:ring-red-800',
    glow: 'shadow-[0_8px_30px_rgba(239,68,68,0.08)]',
  },
  cyan: {
    icon: 'text-cyan-500',
    value: 'text-cyan-600 dark:text-cyan-400',
    bg: 'bg-cyan-50 dark:bg-cyan-950/30',
    ring: 'ring-cyan-200 dark:ring-cyan-800',
    glow: 'shadow-[0_8px_30px_rgba(6,182,212,0.08)]',
  },
};

export const MetricCard = memo(function MetricCard({
  title, value, subtitle, icon: Icon, trend, color = 'primary', pulse,
}: MetricCardProps) {
  const c = COLOR_MAP[color];
  return (
    <div className={cn(
      'relative overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700/60 p-5',
      'bg-white dark:bg-slate-800/80 backdrop-blur-sm',
      'transition-all duration-300 hover:scale-[1.02]',
      c.glow,
    )}>
      {/* Subtle gradient overlay */}
      <div className={cn('absolute inset-0 opacity-[0.03]', c.bg)} />

      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
            {title}
          </p>
          <p className={cn('text-3xl font-bold tabular-nums tracking-tight', c.value)}>
            {value}
          </p>
          {subtitle && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">{subtitle}</p>
          )}
          {trend && (
            <div className={cn(
              'flex items-center gap-1 mt-2 text-[11px] font-medium',
              trend.value >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
            )}>
              {trend.value >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              <span>{trend.value >= 0 ? '+' : ''}{trend.value}% {trend.label}</span>
            </div>
          )}
        </div>
        <div className={cn('p-2.5 rounded-lg', c.bg)}>
          <div className="relative">
            <Icon className={cn('w-5 h-5', c.icon)} />
            {pulse && (
              <span className={cn('absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full', c.icon.replace('text-', 'bg-'))}>
                <span className={cn('absolute inset-0 rounded-full animate-ping opacity-75', c.icon.replace('text-', 'bg-'))} />
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
