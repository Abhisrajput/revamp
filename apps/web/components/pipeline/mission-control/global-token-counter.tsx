'use client';

import { memo } from 'react';
import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────

interface GlobalTokenCounterProps {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  className?: string;
}

// ─── Formatting ─────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

// ─── Component ──────────────────────────────────────────────────

export const GlobalTokenCounter = memo(function GlobalTokenCounter({
  inputTokens,
  outputTokens,
  cost,
  className,
}: GlobalTokenCounterProps) {
  const totalTokens = inputTokens + outputTokens;

  if (totalTokens === 0) return null;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 py-0.5 rounded-md',
        'bg-amber-50 dark:bg-amber-900/20',
        'text-amber-700 dark:text-amber-400',
        'text-[10px] font-mono',
        className,
      )}
      title={`Input: ${inputTokens.toLocaleString()} | Output: ${outputTokens.toLocaleString()} | Cost: ${formatCost(cost)}`}
    >
      <Zap className="w-3 h-3" />
      <span>{formatTokens(totalTokens)}</span>
      <span className="text-amber-400 dark:text-amber-600">|</span>
      <span>{formatCost(cost)}</span>
    </div>
  );
});
