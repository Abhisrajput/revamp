

import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';

// --- Types ---

interface ElapsedTimerProps {
  startedAt: string | null;
  completedAt: string | null;
}

// --- Helpers ---

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// --- Component ---

/**
 * Elapsed timer that never resets unexpectedly.
 * A single interval ticks every second (depends only on isRunning boolean).
 * Elapsed time is computed inline from props — no effect dep on startedAt.
 */
export function ElapsedTimer({ startedAt, completedAt }: ElapsedTimerProps) {
  const isRunning = !!startedAt && !completedAt;
  const [, setTick] = useState(0);

  // Single interval — only depends on isRunning (boolean). Never restarts
  // when startedAt/completedAt string values change.
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  if (!startedAt) return null;

  // Compute elapsed inline — always correct, no stale state
  const start = new Date(startedAt).getTime();
  const elapsed = completedAt
    ? formatElapsed(new Date(completedAt).getTime() - start)
    : formatElapsed(Date.now() - start);

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
      <Clock className={`h-3.5 w-3.5 ${isRunning ? 'animate-spin' : ''}`} />
      <span>{elapsed}</span>
    </div>
  );
}
