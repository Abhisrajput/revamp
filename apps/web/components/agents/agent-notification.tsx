/**
 * Agent Notification Toast — shows real-time notifications for important agent events.
 *
 * Renders in the bottom-right corner of the screen. Auto-dismisses after 5 seconds.
 * Clicking navigates to the relevant agent.
 *
 * Events shown:
 * - Task completed (green)
 * - Task failed (red)
 * - Task escalated (amber)
 * - Budget warning (amber)
 */

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAgentEvents, type AgentEvent, type AgentEventType } from '@/lib/hooks/use-agent-events';
import {
  CheckCircle2,
  XCircle,
  ArrowUpCircle,
  Wallet,
  X,
} from 'lucide-react';

// ─── CONFIG ─────────────────────────────────────────────────────

const AUTO_DISMISS_MS = 5000;

/** Only show notifications for these event types */
const NOTIFIABLE_EVENTS: Set<AgentEventType> = new Set([
  'agent.task_completed',
  'agent.task_failed',
  'agent.task_escalated',
  'agent.budget_warning',
]);

interface NotificationMeta {
  icon: typeof CheckCircle2;
  bgClass: string;
  borderClass: string;
  iconClass: string;
  titleClass: string;
}

const NOTIFICATION_META: Partial<Record<AgentEventType, NotificationMeta>> = {
  'agent.task_completed': {
    icon: CheckCircle2,
    bgClass: 'bg-emerald-50 dark:bg-emerald-900/10',
    borderClass: 'border-emerald-200 dark:border-emerald-800/50',
    iconClass: 'text-emerald-500',
    titleClass: 'text-emerald-800 dark:text-emerald-300',
  },
  'agent.task_failed': {
    icon: XCircle,
    bgClass: 'bg-red-50 dark:bg-red-900/10',
    borderClass: 'border-red-200 dark:border-red-800/50',
    iconClass: 'text-red-500',
    titleClass: 'text-red-800 dark:text-red-300',
  },
  'agent.task_escalated': {
    icon: ArrowUpCircle,
    bgClass: 'bg-amber-50 dark:bg-amber-900/10',
    borderClass: 'border-amber-200 dark:border-amber-800/50',
    iconClass: 'text-amber-500',
    titleClass: 'text-amber-800 dark:text-amber-300',
  },
  'agent.budget_warning': {
    icon: Wallet,
    bgClass: 'bg-amber-50 dark:bg-amber-900/10',
    borderClass: 'border-amber-200 dark:border-amber-800/50',
    iconClass: 'text-amber-500',
    titleClass: 'text-amber-800 dark:text-amber-300',
  },
};

// ─── TYPES ──────────────────────────────────────────────────────

interface Toast {
  id: string;
  event: AgentEvent;
  expiresAt: number;
}

// ─── HELPERS ────────────────────────────────────────────────────

function getTitle(eventType: AgentEventType): string {
  switch (eventType) {
    case 'agent.task_completed': return 'Task Completed';
    case 'agent.task_failed': return 'Task Failed';
    case 'agent.task_escalated': return 'Escalation Required';
    case 'agent.budget_warning': return 'Budget Warning';
    default: return 'Agent Event';
  }
}

function getDescription(event: AgentEvent): string {
  switch (event.eventType) {
    case 'agent.task_completed': {
      const cost = typeof event.data.costCents === 'number'
        ? ` ($${(Number(event.data.costCents) / 100).toFixed(2)})`
        : '';
      return `${event.agentName} completed a task${cost}`;
    }
    case 'agent.task_failed':
      return `${event.agentName}: ${event.data.error || 'task failed'}`;
    case 'agent.task_escalated':
      return `${event.agentName}: ${event.data.reason || 'needs attention'}`;
    case 'agent.budget_warning': {
      const pct = typeof event.data.percentUsed === 'number'
        ? ` (${(Number(event.data.percentUsed) * 100).toFixed(0)}% used)`
        : '';
      return `${event.agentName} budget warning${pct}`;
    }
    default:
      return event.agentName;
  }
}

// ─── COMPONENT ──────────────────────────────────────────────────

export function AgentNotifications() {
  const { lastEvent } = useAgentEvents({ maxEvents: 5 });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const processedRef = useRef<Set<string>>(new Set());
  const router = useRouter();

  // Add new toast when a notifiable event arrives
  useEffect(() => {
    if (!lastEvent) return;
    if (!NOTIFIABLE_EVENTS.has(lastEvent.eventType)) return;

    // Deduplicate using timestamp + agentId
    const key = `${lastEvent.timestamp}-${lastEvent.agentId}-${lastEvent.eventType}`;
    if (processedRef.current.has(key)) return;
    processedRef.current.add(key);

    // Keep the processed set from growing unbounded
    if (processedRef.current.size > 100) {
      const entries = Array.from(processedRef.current);
      processedRef.current = new Set(entries.slice(-50));
    }

    const toast: Toast = {
      id: key,
      event: lastEvent,
      expiresAt: Date.now() + AUTO_DISMISS_MS,
    };

    setToasts((prev) => [toast, ...prev].slice(0, 5));
  }, [lastEvent]);

  // Auto-dismiss timer
  useEffect(() => {
    if (toasts.length === 0) return;

    const timer = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => t.expiresAt > now));
    }, 1000);

    return () => clearInterval(timer);
  }, [toasts.length]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const handleClick = useCallback((agentId: string) => {
    router.push(`/agents/${agentId}`);
  }, [router]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((toast) => {
        const meta = NOTIFICATION_META[toast.event.eventType];
        if (!meta) return null;
        const Icon = meta.icon;

        return (
          <div
            key={toast.id}
            onClick={() => handleClick(toast.event.agentId)}
            className={cn(
              'pointer-events-auto rounded-lg border p-3 shadow-lg cursor-pointer transition-all duration-300 animate-in slide-in-from-right-5 fade-in',
              meta.bgClass,
              meta.borderClass,
            )}
          >
            <div className="flex items-start gap-3">
              <Icon className={cn('w-5 h-5 mt-0.5 flex-shrink-0', meta.iconClass)} />
              <div className="flex-1 min-w-0">
                <p className={cn('text-sm font-medium', meta.titleClass)}>
                  {getTitle(toast.event.eventType)}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5 truncate">
                  {getDescription(toast.event)}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dismissToast(toast.id);
                }}
                className="flex-shrink-0 p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
