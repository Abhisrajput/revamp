

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

export function ElapsedTimer({ startedAt, completedAt }: ElapsedTimerProps) {
  const [elapsed, setElapsed] = useState('0:00');

  useEffect(() => {
    if (!startedAt) {
      setElapsed('0:00');
      return;
    }

    const start = new Date(startedAt).getTime();

    // Stage completed — show final duration and stop ticking
    if (completedAt) {
      const end = new Date(completedAt).getTime();
      setElapsed(formatElapsed(end - start));
      return;
    }

    // Stage is running — tick every second
    setElapsed(formatElapsed(Date.now() - start));
    const interval = setInterval(() => {
      setElapsed(formatElapsed(Date.now() - start));
    }, 1000);

    return () => clearInterval(interval);
  }, [startedAt, completedAt]);

  if (!startedAt) return null;

  const isRunning = startedAt && !completedAt;

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
      <Clock className={`h-3.5 w-3.5 ${isRunning ? 'animate-spin' : ''}`} />
      <span>{elapsed}</span>
    </div>
  );
}
