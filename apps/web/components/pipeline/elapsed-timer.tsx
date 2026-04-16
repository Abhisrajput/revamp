'use client';

import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';

interface ElapsedTimerProps {
  startedAt: string | null;
  completedAt: string | null;
  status?: string;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Elapsed timer — reads timestamps from the v2 stage_executions API.
 *
 * Stops when ANY of these is true:
 *   - completedAt is set (normal path — v2 always provides this)
 *   - status is terminal (defense-in-depth fallback)
 *   - startedAt is absent (stage not started)
 */
export function ElapsedTimer({ startedAt, completedAt, status }: ElapsedTimerProps) {
  const isTerminal = status === 'completed' || status === 'failed' || status === 'approved';
  const isRunning = !!startedAt && !completedAt && !isTerminal;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  if (!startedAt) return null;

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
