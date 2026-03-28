'use client';

import { useRef, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { ExecutionLogEntry } from '@/lib/hooks/use-orchestrator';

// ─── CONSTANTS ──────────────────────────────────────────────────

const LEVEL_STYLES: Record<string, { dot: string; text: string; bg: string }> = {
  info: { dot: 'bg-slate-400', text: 'text-slate-300 dark:text-slate-400', bg: '' },
  success: { dot: 'bg-green-400', text: 'text-green-400', bg: 'bg-green-500/5' },
  warning: { dot: 'bg-amber-400', text: 'text-amber-400', bg: 'bg-amber-500/5' },
  error: { dot: 'bg-red-400', text: 'text-red-400', bg: 'bg-red-500/5' },
};

// ─── COMPONENT ──────────────────────────────────────────────────

interface ExecutionLogProps {
  entries: ExecutionLogEntry[];
  maxVisible?: number;
}

export function ExecutionLog({ entries, maxVisible = 100 }: ExecutionLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to top when new entries arrive (newest is first)
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [entries.length]);

  // Group entries by date
  const grouped = useMemo(() => {
    const visible = entries.slice(0, maxVisible);
    const groups: { date: string; label: string; entries: ExecutionLogEntry[] }[] = [];
    let currentDate = '';

    for (const entry of visible) {
      const dateStr = formatDateGroup(entry.timestamp);
      if (dateStr !== currentDate) {
        currentDate = dateStr;
        groups.push({ date: dateStr, label: formatDateLabel(entry.timestamp), entries: [] });
      }
      groups[groups.length - 1].entries.push(entry);
    }

    return groups;
  }, [entries, maxVisible]);

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
        <div className="w-8 h-8 mb-2 rounded border border-dashed border-slate-300 dark:border-slate-600 flex items-center justify-center text-[10px]">
          &gt;_
        </div>
        <p className="text-xs">No agent activity</p>
        <p className="text-[10px] mt-1 opacity-70">Activity appears here when agents execute tasks</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="space-y-0 font-mono text-[11px] max-h-[500px] overflow-y-auto scrollbar-thin"
    >
      {grouped.map((group) => (
        <div key={group.date}>
          {/* Date separator */}
          <div className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1.5 bg-slate-50/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-slate-200/50 dark:border-slate-700/30">
            <span className="text-[9px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              {group.label}
            </span>
            <span className="text-[9px] text-slate-300 dark:text-slate-600">
              ({group.entries.length})
            </span>
          </div>

          {/* Entries */}
          {group.entries.map((entry, idx) => {
            const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;
            const time = formatLogTime(entry.timestamp);
            const isFirst = idx === 0 && group === grouped[0];

            return (
              <div
                key={entry.id}
                className={cn(
                  'flex gap-2 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors',
                  isFirst && 'bg-slate-50 dark:bg-slate-800/30',
                  style.bg,
                )}
              >
                {/* Level dot */}
                <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0', style.dot)} />

                {/* Timestamp */}
                <span className="text-slate-500 dark:text-slate-500 flex-shrink-0 tabular-nums">
                  {time}
                </span>

                {/* Action tag */}
                <span className={cn('flex-shrink-0 font-semibold', style.text)}>
                  [{entry.action}]
                </span>

                {/* Detail */}
                <span className="text-slate-600 dark:text-slate-300 truncate flex-1 min-w-0">
                  {entry.detail}
                </span>

                {/* Department badge */}
                {entry.department && (
                  <span className="text-[9px] text-slate-400 dark:text-slate-600 flex-shrink-0 uppercase">
                    {entry.department.slice(0, 4)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────

function formatLogTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

function formatDateGroup(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toISOString().split('T')[0];
  } catch {
    return 'unknown';
  }
}

function formatDateLabel(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'Unknown';
  }
}
