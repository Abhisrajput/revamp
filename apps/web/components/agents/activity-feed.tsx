/**
 * Agent Activity Feed — real-time feed of agent lifecycle events.
 *
 * Connects via useAgentEvents and displays a rolling list of the most recent
 * events, color-coded by type and auto-scrolling as new events arrive.
 */

'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { useAgentEvents, type AgentEvent, type AgentEventType } from '@/lib/hooks/use-agent-events';
import {
  Activity,
  CheckCircle2,
  PlayCircle,
  XCircle,
  ArrowUpCircle,
  Wallet,
  Ban,
  RefreshCw,
  Brain,
  ArrowRight,
  MessageSquare,
  AlertTriangle,
} from 'lucide-react';

// ─── EVENT CONFIG ────────────────────────────────────────────

interface EventMeta {
  icon: typeof Activity;
  label: string;
  color: string;
  badgeClass: string;
}

const EVENT_META: Record<AgentEventType, EventMeta> = {
  'agent.task_assigned': {
    icon: PlayCircle,
    label: 'Task Assigned',
    color: 'text-blue-500',
    badgeClass: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  },
  'agent.task_started': {
    icon: RefreshCw,
    label: 'Task Started',
    color: 'text-blue-600',
    badgeClass: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  },
  'agent.task_completed': {
    icon: CheckCircle2,
    label: 'Task Completed',
    color: 'text-emerald-500',
    badgeClass: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
  },
  'agent.task_failed': {
    icon: XCircle,
    label: 'Task Failed',
    color: 'text-red-500',
    badgeClass: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  },
  'agent.task_escalated': {
    icon: ArrowUpCircle,
    label: 'Task Escalated',
    color: 'text-amber-500',
    badgeClass: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  },
  'agent.status_changed': {
    icon: Activity,
    label: 'Status Changed',
    color: 'text-slate-500',
    badgeClass: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
  },
  'agent.budget_warning': {
    icon: Wallet,
    label: 'Budget Warning',
    color: 'text-amber-500',
    badgeClass: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  },
  'agent.budget_exceeded': {
    icon: Ban,
    label: 'Budget Exceeded',
    color: 'text-red-600',
    badgeClass: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  },
  'agent.memory_updated': {
    icon: Brain,
    label: 'Memory Updated',
    color: 'text-purple-500',
    badgeClass: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  },
  'agent.delegated': {
    icon: ArrowRight,
    label: 'Delegated',
    color: 'text-blue-500',
    badgeClass: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  },
  'agent.message': {
    icon: MessageSquare,
    label: 'Message',
    color: 'text-slate-500',
    badgeClass: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
  },
  'agent.error': {
    icon: AlertTriangle,
    label: 'Error',
    color: 'text-red-500',
    badgeClass: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  },
};

// ─── HELPERS ─────────────────────────────────────────────────

function describeEvent(event: AgentEvent): string {
  switch (event.eventType) {
    case 'agent.task_assigned':
      return `Assigned to stage "${event.data.stageName || 'unknown'}"`;
    case 'agent.task_started':
      return `Started working on task`;
    case 'agent.task_completed': {
      const cost = typeof event.data.costCents === 'number'
        ? ` ($${(event.data.costCents / 100).toFixed(2)})`
        : '';
      return `Completed task${cost}`;
    }
    case 'agent.task_failed':
      return `Task failed: ${event.data.error || 'unknown error'}`;
    case 'agent.task_escalated':
      return `Escalated: ${event.data.reason || 'no reason given'}`;
    case 'agent.status_changed':
      return `Status changed to "${event.data.newStatus}"${event.data.reason ? ` (${event.data.reason})` : ''}`;
    case 'agent.budget_warning': {
      const pct = typeof event.data.percentUsed === 'number'
        ? ` (${(event.data.percentUsed * 100).toFixed(0)}% used)`
        : '';
      return `Budget warning${pct}`;
    }
    case 'agent.budget_exceeded':
      return `Budget exceeded — agent halted`;
    default:
      return 'Unknown event';
  }
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── COMPONENT ───────────────────────────────────────────────

interface ActivityFeedProps {
  /** Filter to a specific agent. */
  agentId?: string;
  /** Maximum events to display. Default: 20 */
  maxDisplay?: number;
  /** Additional CSS class for the container. */
  className?: string;
}

export function ActivityFeed({ agentId, maxDisplay = 20, className }: ActivityFeedProps) {
  const { events, connected } = useAgentEvents({
    agentId,
    maxEvents: maxDisplay,
  });

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the top when new events arrive (newest first)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [events.length]);

  const displayedEvents = events.slice(0, maxDisplay);

  return (
    <Card className={cn('bg-white dark:bg-slate-800', className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">Activity Feed</CardTitle>
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-2 h-2 rounded-full',
                connected ? 'bg-emerald-500' : 'bg-slate-400',
              )}
            />
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {connected ? 'Live' : 'Disconnected'}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div
          ref={scrollRef}
          className="space-y-1 max-h-[400px] overflow-y-auto pr-1 scrollbar-thin"
        >
          {displayedEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-slate-400 dark:text-slate-500">
              <Activity className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm">No events yet</p>
              <p className="text-xs mt-1">
                {connected ? 'Waiting for agent activity...' : 'Reconnecting...'}
              </p>
            </div>
          ) : (
            displayedEvents.map((event, index) => (
              <ActivityFeedItem key={`${event.timestamp}-${index}`} event={event} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── FEED ITEM ───────────────────────────────────────────────

function ActivityFeedItem({ event }: { event: AgentEvent }) {
  const meta = EVENT_META[event.eventType] || EVENT_META['agent.status_changed'];
  const Icon = meta.icon;

  return (
    <div className="flex items-start gap-3 py-2 px-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
      {/* Icon */}
      <div className={cn('mt-0.5 flex-shrink-0', meta.color)}>
        <Icon className="w-4 h-4" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-50 truncate">
            {event.agentName}
          </span>
          <Badge className={cn('text-[10px] px-1.5 py-0', meta.badgeClass)}>
            {meta.label}
          </Badge>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed truncate">
          {describeEvent(event)}
        </p>
      </div>

      {/* Timestamp */}
      <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 flex-shrink-0 tabular-nums mt-0.5">
        {formatTimestamp(event.timestamp)}
      </span>
    </div>
  );
}
