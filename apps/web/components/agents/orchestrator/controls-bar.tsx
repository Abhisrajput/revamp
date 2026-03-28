'use client';

import { cn } from '@/lib/utils';
import { Play, Pause, RotateCcw, Wifi, WifiOff } from 'lucide-react';
import type { OrchestratorState } from '@/lib/hooks/use-orchestrator';

// ─── COMPONENT ──────────────────────────────────────────────────

interface ControlsBarProps {
  state: OrchestratorState;
  connected: boolean;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
}

export function ControlsBar({ state, connected, onStart, onPause, onReset }: ControlsBarProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {/* Start / Pause toggle */}
        {state !== 'running' ? (
          <button
            onClick={onStart}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary-600 text-white hover:bg-primary-700 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            {state === 'paused' ? 'Resume' : 'Start'}
          </button>
        ) : (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
          >
            <Pause className="w-3.5 h-3.5" />
            Pause
          </button>
        )}

        {/* Reset */}
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>
      </div>

      {/* Connection status */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] font-medium',
            connected
              ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
              : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
          )}
        >
          {connected ? (
            <Wifi className="w-3 h-3" />
          ) : (
            <WifiOff className="w-3 h-3" />
          )}
          {connected ? 'Connected' : 'Disconnected'}
        </div>

        {/* State badge */}
        <div
          className={cn(
            'px-2.5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider',
            state === 'running' && 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400',
            state === 'paused' && 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
            state === 'idle' && 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
          )}
        >
          {state}
        </div>
      </div>
    </div>
  );
}
