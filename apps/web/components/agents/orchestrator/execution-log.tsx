'use client';

import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight, ExternalLink, Clock, User, Layers } from 'lucide-react';
import type { ExecutionLogEntry } from '@/lib/hooks/use-orchestrator';

// ─── CONSTANTS ──────────────────────────────────────────────────

const LEVEL_STYLES: Record<string, { dot: string; text: string; bg: string; badge: string }> = {
  info: { dot: 'bg-slate-400', text: 'text-slate-500 dark:text-slate-400', bg: '', badge: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300' },
  success: { dot: 'bg-green-400', text: 'text-green-600 dark:text-green-400', bg: 'hover:bg-green-50/50 dark:hover:bg-green-950/10', badge: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' },
  warning: { dot: 'bg-amber-400', text: 'text-amber-600 dark:text-amber-400', bg: 'hover:bg-amber-50/50 dark:hover:bg-amber-950/10', badge: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' },
  warn: { dot: 'bg-amber-400', text: 'text-amber-600 dark:text-amber-400', bg: 'hover:bg-amber-50/50 dark:hover:bg-amber-950/10', badge: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' },
  error: { dot: 'bg-red-400', text: 'text-red-600 dark:text-red-400', bg: 'hover:bg-red-50/50 dark:hover:bg-red-950/10', badge: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400' },
};

const ACTION_LABELS: Record<string, string> = {
  COMPLETE: 'Stage Complete',
  FAIL: 'Stage Failed',
  EXECUTE: 'Stage Running',
  persona_created: 'Agent Created',
  persona_updated: 'Agent Updated',
  persona_deleted: 'Agent Deleted',
  subtask_created: 'Subtask Created',
  subtask_completed: 'Subtask Done',
  assignment_created: 'Task Assigned',
  budget_warning: 'Budget Warning',
  budget_hard_stop: 'Budget Stop',
  agent_resumed: 'Agent Resumed',
  budgets_reconciled: 'Reconciliation',
};

// ─── COMPONENT ──────────────────────────────────────────────────

interface ExecutionLogProps {
  entries: ExecutionLogEntry[];
  maxVisible?: number;
}

export function ExecutionLog({ entries, maxVisible = 100 }: ExecutionLogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [entries.length]);

  const toggle = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  }, []);

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
    <div ref={containerRef} className="max-h-[500px] overflow-y-auto scrollbar-thin">
      {grouped.map((group) => (
        <div key={group.date}>
          {/* Date separator */}
          <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-slate-50/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-slate-200/50 dark:border-slate-700/30">
            <span className="text-[9px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              {group.label}
            </span>
            <span className="text-[9px] text-slate-300 dark:text-slate-600">
              ({group.entries.length})
            </span>
          </div>

          {/* Entries */}
          {group.entries.map((entry) => (
            <LogEntry
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={toggle}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── LOG ENTRY ROW ──────────────────────────────────────────────

function LogEntry({ entry, expanded, onToggle }: {
  entry: ExecutionLogEntry;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;
  const time = formatLogTime(entry.timestamp);
  const actionLabel = ACTION_LABELS[entry.action] || entry.action;
  const hasDetails = entry.details && (typeof entry.details === 'object' ? Object.keys(entry.details).length > 0 : entry.details.length > 2);

  return (
    <div className={cn('border-b border-slate-100 dark:border-slate-800/50 last:border-b-0')}>
      {/* Main row — always visible, clickable */}
      <button
        onClick={() => onToggle(entry.id)}
        className={cn(
          'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
          'hover:bg-slate-50 dark:hover:bg-slate-800/40',
          expanded && 'bg-slate-50 dark:bg-slate-800/30',
          style.bg,
        )}
      >
        {/* Expand chevron */}
        <span className="w-4 h-4 flex items-center justify-center shrink-0 text-slate-400">
          {hasDetails ? (
            expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />
          ) : (
            <span className={cn('w-1.5 h-1.5 rounded-full', style.dot)} />
          )}
        </span>

        {/* Timestamp */}
        <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono tabular-nums shrink-0">
          {time}
        </span>

        {/* Action badge */}
        <Badge className={cn('text-[9px] px-1.5 py-0 shrink-0', style.badge)}>
          {actionLabel}
        </Badge>

        {/* Agent name */}
        {entry.agentName && entry.agentName !== 'Unknown Agent' && (
          <span className="text-[11px] font-medium text-slate-700 dark:text-slate-200 shrink-0 max-w-[120px] truncate">
            {entry.agentName}
          </span>
        )}

        {/* Detail summary */}
        <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate flex-1 min-w-0">
          {entry.detail || ''}
        </span>

        {/* Department */}
        {entry.department && (
          <span className="text-[9px] text-slate-400 dark:text-slate-600 uppercase shrink-0">
            {entry.department.slice(0, 4)}
          </span>
        )}
      </button>

      {/* Expanded detail panel */}
      {expanded && hasDetails && (
        <div className="px-3 pb-3 pt-1 ml-9 animate-in slide-in-from-top-1 duration-150">
          <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 p-3">
            {/* Meta row */}
            <div className="flex flex-wrap gap-3 mb-3 text-[10px] text-slate-500">
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(entry.timestamp).toLocaleString()}
              </span>
              {entry.agentName && (
                <span className="flex items-center gap-1">
                  <User className="w-3 h-3" />
                  {entry.agentName}
                </span>
              )}
              {entry.department && (
                <span className="flex items-center gap-1">
                  <Layers className="w-3 h-3" />
                  {entry.department}
                </span>
              )}
              {entry.agentId && (
                <a
                  href={`/agents/${entry.agentId}`}
                  className="flex items-center gap-1 text-primary-500 hover:text-primary-600"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="w-3 h-3" />
                  View Agent
                </a>
              )}
            </div>

            {/* Details content */}
            <DetailView details={entry.details} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DETAIL VIEW ────────────────────────────────────────────────

function DetailView({ details }: { details: string | Record<string, unknown> }) {
  const data = typeof details === 'string' ? tryParseJSON(details) : details;

  if (!data || (typeof data === 'string' && data.length < 3)) {
    return <p className="text-xs text-slate-400">No additional details</p>;
  }

  if (typeof data === 'string') {
    return <p className="text-xs text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{data}</p>;
  }

  // Render as a clean key-value table
  return (
    <div className="space-y-1.5">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="flex gap-3 text-xs">
          <span className="text-slate-400 dark:text-slate-500 font-mono shrink-0 w-28 text-right">
            {key.replace(/_/g, ' ')}
          </span>
          <span className="text-slate-700 dark:text-slate-200 break-all">
            {renderValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  if (Array.isArray(value)) return value.join(', ') || '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function tryParseJSON(str: string): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' ? parsed : str;
  } catch {
    return str;
  }
}

// ─── HELPERS ────────────────────────────────────────────────────

function formatLogTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '--:--:--';
  }
}

function formatDateGroup(iso: string): string {
  try {
    return new Date(iso).toISOString().split('T')[0];
  } catch {
    return 'unknown';
  }
}

function formatDateLabel(iso: string): string {
  try {
    const d = new Date(iso);
    const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'Unknown';
  }
}
