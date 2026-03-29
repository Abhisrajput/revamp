'use client';

import { cn } from '@/lib/utils';
import { Play, Pause, RotateCcw, Wifi, WifiOff } from 'lucide-react';
import type { OrchestratorState } from '@/lib/hooks/use-orchestrator';

const STATE_CONFIG: Record<string, { label: string; color: string; bg: string; dot: string }> = {
  running: { label: 'Running', color: 'text-cyan-600 dark:text-cyan-400', bg: 'bg-cyan-100 dark:bg-cyan-900/20', dot: 'bg-cyan-400' },
  paused:  { label: 'Paused',  color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/20', dot: 'bg-amber-400' },
  idle:    { label: 'Idle',    color: 'text-slate-500 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800', dot: 'bg-slate-400' },
  stopped: { label: 'Stopped', color: 'text-slate-500 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800', dot: 'bg-slate-400' },
  error:   { label: 'Error',   color: 'text-red-600 dark:text-red-400', bg: 'bg-red-100 dark:bg-red-900/20', dot: 'bg-red-400' },
};

interface ControlsBarProps {
  state: OrchestratorState;
  connected: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
}

export function ControlsBar({ state, connected, onStart, onPause, onReset }: ControlsBarProps) {
  const cfg = STATE_CONFIG[state] || STATE_CONFIG.idle;
  const isRunning = state === 'running';

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        {/* State indicator with pulsing dot */}
        <div className={cn('flex items-center gap-2 px-3 py-1.5 rounded-full transition-all', cfg.bg,
          isRunning && 'shadow-[0_0_20px_rgba(6,182,212,0.12)]',
        )}>
          <div className="relative">
            <span className={cn('w-2.5 h-2.5 rounded-full block', cfg.dot)} />
            {isRunning && (
              <span className={cn('absolute inset-0 w-2.5 h-2.5 rounded-full animate-ping opacity-75', cfg.dot)} />
            )}
          </div>
          <span className={cn('text-sm font-semibold', cfg.color)}>{cfg.label}</span>
        </div>

        {/* Connection */}
        <div className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium',
          connected
            ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
            : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
        )}>
          {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {connected ? 'Connected' : 'Disconnected'}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isRunning ? (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/20 transition-colors"
          >
            <Pause className="w-3.5 h-3.5" />
            Pause
          </button>
        ) : (
          <button
            onClick={onStart}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-cyan-600 text-white hover:bg-cyan-700 transition-colors shadow-[0_4px_12px_rgba(6,182,212,0.25)]"
          >
            <Play className="w-3.5 h-3.5" />
            {state === 'paused' ? 'Resume' : 'Start'}
          </button>
        )}
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>
      </div>
    </div>
  );
}
