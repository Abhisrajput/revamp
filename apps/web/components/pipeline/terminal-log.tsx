'use client';

import { useRef, useEffect, useState, memo, useCallback } from 'react';
import { Terminal, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// --- Types ---

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug' | 'tool';
  message: string;
  detail?: string;
}

interface TerminalLogProps {
  logs: LogEntry[];
  className?: string;
  maxHeight?: string;
  autoScroll?: boolean;
  title?: string;
  collapsed?: boolean;
}

// --- Level Colors ---

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
  debug: 'text-slate-500',
  tool: 'text-emerald-400',
};

const LEVEL_LABELS: Record<LogEntry['level'], string> = {
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  debug: 'DBG',
  tool: 'TUL',
};

// --- Component ---

export const TerminalLog = memo(function TerminalLog({
  logs,
  className,
  maxHeight = '300px',
  autoScroll = true,
  title = 'Terminal',
  collapsed: initialCollapsed = false,
}: TerminalLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [copied, setCopied] = useState(false);

  // Auto-scroll on new logs
  useEffect(() => {
    if (autoScroll && !collapsed && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll, collapsed]);

  const handleCopy = useCallback(() => {
    const text = logs
      .map((log) => `[${log.timestamp}] [${LEVEL_LABELS[log.level]}] ${log.message}${log.detail ? `\n  ${log.detail}` : ''}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [logs]);

  return (
    <div className={cn('rounded-lg border border-slate-700 bg-slate-950 overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-700">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          <Terminal className="h-3.5 w-3.5" />
          <span className="font-medium">{title}</span>
          <span className="text-slate-500 tabular-nums">({logs.length})</span>
          {collapsed ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronUp className="h-3 w-3" />
          )}
        </button>
        {!collapsed && logs.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-slate-400 hover:text-slate-200"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-400" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </Button>
        )}
      </div>

      {/* Log content */}
      {!collapsed && (
        <div
          ref={containerRef}
          className="overflow-y-auto font-mono text-xs p-2 space-y-0.5"
          style={{ maxHeight }}
        >
          {logs.length === 0 ? (
            <p className="text-slate-600 text-center py-4">Waiting for activity...</p>
          ) : (
            logs.map((log, idx) => (
              <div key={log.id ?? idx} className="flex items-start gap-2 py-0.5 hover:bg-slate-900/50 px-1 rounded">
                <span className="text-slate-600 shrink-0 tabular-nums">
                  {formatTime(log.timestamp)}
                </span>
                <span className={cn('shrink-0 font-semibold', LEVEL_COLORS[log.level])}>
                  [{LEVEL_LABELS[log.level]}]
                </span>
                <span className="text-slate-300 break-all">
                  {log.message}
                  {log.detail && (
                    <span className="text-slate-500 block ml-2 mt-0.5">{log.detail}</span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});

// --- Helpers ---

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return timestamp;
  }
}

// --- Hook for building log entries ---

let logIdCounter = 0;
export function createLogEntry(
  level: LogEntry['level'],
  message: string,
  detail?: string,
): LogEntry {
  return {
    id: `log-${++logIdCounter}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    detail,
  };
}
