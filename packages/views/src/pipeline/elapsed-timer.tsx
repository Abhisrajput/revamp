

import { useState, useEffect, useRef } from 'react';
import { Clock } from 'lucide-react';

// --- Types ---

interface ElapsedTimerProps {
  startedAt: string | null;
  completedAt: string | null;
  /** Stage status — used as a fallback stop signal when completedAt is missing */
  status?: string;
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
 * Elapsed timer — DB-driven, single source of truth.
 *
 * Stops when ANY of these is true:
 *   - completedAt is set (normal path, from DB)
 *   - status is terminal (defense-in-depth for legacy/corrupted data)
 *   - startedAt is absent (stage not started)
 *
 * When terminal without completedAt, freezes the display at the last
 * live value via useRef to avoid jumps.
 */
export function ElapsedTimer({ startedAt, completedAt, status }: ElapsedTimerProps) {
  const isTerminal = status === 'completed' || status === 'failed' || status === 'approved';
  const isRunning = !!startedAt && !completedAt && !isTerminal;
  const [, setTick] = useState(0);

  // Freeze the displayed time when the stage becomes terminal without
  // completedAt. Captures the last live value so we don't jump to 0:00.
  const frozenRef = useRef<string | null>(null);
  if (isRunning) {
    frozenRef.current = null;
  } else if (isTerminal && !completedAt && !frozenRef.current && startedAt) {
    frozenRef.current = formatElapsed(Date.now() - new Date(startedAt).getTime());
  }

  // Single interval — only depends on isRunning (boolean).
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  if (!startedAt) return null;

  const start = new Date(startedAt).getTime();
  let elapsed: string;
  if (completedAt) {
    // Normal path: exact duration from DB timestamps
    elapsed = formatElapsed(new Date(completedAt).getTime() - start);
  } else if (isTerminal) {
    // Fallback: terminal without completedAt (legacy data) — show frozen value
    elapsed = frozenRef.current || formatElapsed(Date.now() - start);
  } else {
    // Running: live ticking
    elapsed = formatElapsed(Date.now() - start);
  }

  return (
    <div className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
      <Clock className={`h-3.5 w-3.5 ${isRunning ? 'animate-spin' : ''}`} />
      <span>{elapsed}</span>
    </div>
  );
}
