/**
 * Agent Interaction Panel — slide-out panel for interacting with a specific agent.
 *
 * Contains:
 * - Header with agent name, role, department, status
 * - Real-time event timeline for this agent
 * - Escalation queue with approve/reject actions
 * - Send instruction input (creates subtask)
 */

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  useAgent,
  useEscalatedAssignments,
  useApproveEscalation,
  useRejectEscalation,
  useCreateSubtask,
} from '@/lib/hooks/use-agents';
import {
  useAgentEvents,
  type AgentEvent,
  type AgentEventType,
} from '@/lib/hooks/use-agent-events';
import {
  X,
  Brain,
  Hammer,
  Shield,
  FileText,
  CheckCircle2,
  XCircle,
  ArrowUpCircle,
  Activity,
  PlayCircle,
  RefreshCw,
  Wallet,
  Ban,
  Send,
  AlertTriangle,
} from 'lucide-react';

// ─── CONSTANTS ──────────────────────────────────────────────────

const DEPT_META: Record<string, { icon: typeof Brain; color: string; label: string }> = {
  discovery: { icon: Brain, color: 'text-purple-500', label: 'Discovery' },
  execution: { icon: Hammer, color: 'text-blue-500', label: 'Execution' },
  qa: { icon: Shield, color: 'text-emerald-500', label: 'QA' },
  pm: { icon: FileText, color: 'text-amber-500', label: 'PM' },
};

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  working: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  paused: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  disabled: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
};

const EVENT_META: Record<AgentEventType, { icon: typeof Activity; color: string; label: string }> = {
  'agent.task_assigned': { icon: PlayCircle, color: 'text-blue-500', label: 'Assigned' },
  'agent.task_started': { icon: RefreshCw, color: 'text-blue-600', label: 'Started' },
  'agent.task_completed': { icon: CheckCircle2, color: 'text-emerald-500', label: 'Completed' },
  'agent.task_failed': { icon: XCircle, color: 'text-red-500', label: 'Failed' },
  'agent.task_escalated': { icon: ArrowUpCircle, color: 'text-amber-500', label: 'Escalated' },
  'agent.status_changed': { icon: Activity, color: 'text-slate-500', label: 'Status' },
  'agent.budget_warning': { icon: Wallet, color: 'text-amber-500', label: 'Budget' },
  'agent.budget_exceeded': { icon: Ban, color: 'text-red-600', label: 'Exceeded' },
  'agent.memory_updated': { icon: Brain, color: 'text-purple-500', label: 'Memory' },
  'agent.delegated': { icon: ArrowUpCircle, color: 'text-blue-500', label: 'Delegated' },
  'agent.message': { icon: Activity, color: 'text-slate-500', label: 'Message' },
  'agent.error': { icon: AlertTriangle, color: 'text-red-500', label: 'Error' },
};

// ─── HELPERS ────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  } catch {
    return iso;
  }
}

// ─── COMPONENT ──────────────────────────────────────────────────

interface AgentInteractionPanelProps {
  agentId: string;
  open: boolean;
  onClose: () => void;
}

export function AgentInteractionPanel({ agentId, open, onClose }: AgentInteractionPanelProps) {
  const { data: agent } = useAgent(agentId);
  const { events, connected } = useAgentEvents({ agentId, maxEvents: 30 });
  const { data: escalations } = useEscalatedAssignments();
  const approveEscalation = useApproveEscalation();
  const rejectEscalation = useRejectEscalation();
  const createSubtask = useCreateSubtask();

  const [instruction, setInstruction] = useState('');
  const [activeTab, setActiveTab] = useState<'timeline' | 'escalations' | 'instruct'>('timeline');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filter escalations for this specific agent
  const agentEscalations = escalations?.filter((e) => e.agent_id === agentId) ?? [];

  // Auto-scroll timeline on new events
  useEffect(() => {
    if (scrollRef.current && activeTab === 'timeline') {
      scrollRef.current.scrollTop = 0;
    }
  }, [events.length, activeTab]);

  const handleSendInstruction = useCallback(() => {
    if (!instruction.trim() || !agent) return;
    createSubtask.mutate({
      created_by_agent_id: agentId,
      pipeline_run_id: '00000000-0000-0000-0000-000000000000', // placeholder for manual instructions
      stage_name: 'manual_instruction',
      title: instruction.trim().slice(0, 100),
      description: instruction.trim(),
    });
    setInstruction('');
  }, [instruction, agent, agentId, createSubtask]);

  const handleApprove = useCallback((escalationAgentId: string) => {
    approveEscalation.mutate(escalationAgentId);
  }, [approveEscalation]);

  const handleReject = useCallback((assignmentId: string) => {
    rejectEscalation.mutate({
      assignmentId,
      result: { rejected: true, reason: 'Rejected by human operator' },
    });
  }, [rejectEscalation]);

  if (!open) return null;

  const dept = agent ? (DEPT_META[agent.department] || DEPT_META.discovery) : DEPT_META.discovery;
  const DeptIcon = dept.icon;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 dark:bg-black/50 transition-opacity"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-lg flex flex-col bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3 min-w-0">
            <div className={cn('w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center', dept.color)}>
              <DeptIcon className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50 truncate">
                {agent?.name ?? 'Loading...'}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                {agent && (
                  <>
                    <Badge className={STATUS_COLORS[agent.status] || STATUS_COLORS.idle}>
                      {agent.status}
                    </Badge>
                    <span className="text-xs text-slate-500 dark:text-slate-400 capitalize">
                      {agent.role} / {dept.label}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 mr-2">
              <div className={cn('w-2 h-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-slate-400')} />
              <span className="text-[11px] text-slate-400">{connected ? 'Live' : 'Offline'}</span>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 px-5">
          {([
            { key: 'timeline' as const, label: 'Timeline', count: events.length },
            { key: 'escalations' as const, label: 'Escalations', count: agentEscalations.length },
            { key: 'instruct' as const, label: 'Instruct', count: 0 },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'px-3 py-2.5 text-sm font-medium border-b-2 transition-colors',
                activeTab === tab.key
                  ? 'border-primary-600 text-primary-600 dark:text-primary-400 dark:border-primary-400'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className={cn(
                  'ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full',
                  tab.key === 'escalations' && tab.count > 0
                    ? 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
                )}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {/* Timeline Tab */}
          {activeTab === 'timeline' && (
            <div ref={scrollRef} className="h-full overflow-y-auto p-4 space-y-1">
              {events.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
                  <Activity className="w-8 h-8 mb-2 opacity-50" />
                  <p className="text-sm">No events yet</p>
                  <p className="text-xs mt-1">
                    {connected ? 'Waiting for agent activity...' : 'Reconnecting...'}
                  </p>
                </div>
              ) : (
                events.map((event, i) => (
                  <TimelineItem key={`${event.timestamp}-${i}`} event={event} />
                ))
              )}
            </div>
          )}

          {/* Escalations Tab */}
          {activeTab === 'escalations' && (
            <div className="h-full overflow-y-auto p-4 space-y-3">
              {agentEscalations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
                  <CheckCircle2 className="w-8 h-8 mb-2 opacity-50" />
                  <p className="text-sm">No pending escalations</p>
                  <p className="text-xs mt-1">This agent has no tasks awaiting review.</p>
                </div>
              ) : (
                agentEscalations.map((esc) => (
                  <div
                    key={esc.id}
                    className="rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-900/10 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                            {esc.stage_name || 'Unknown stage'}
                          </span>
                          <span className="text-[11px] font-mono text-slate-400">
                            {formatRelative(esc.updated_at ?? esc.created_at)}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 mb-3 leading-relaxed">
                          {esc.error_message || 'No reason provided'}
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleApprove(esc.agent_id)}
                            disabled={approveEscalation.isPending}
                            className="text-xs"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleReject(esc.id)}
                            disabled={rejectEscalation.isPending}
                            className="text-xs"
                          >
                            <XCircle className="w-3.5 h-3.5 mr-1" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Instruct Tab */}
          {activeTab === 'instruct' && (
            <div className="h-full flex flex-col p-4">
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 mb-4">
                <Send className="w-8 h-8 mb-2 opacity-50" />
                <p className="text-sm font-medium">Send an instruction</p>
                <p className="text-xs mt-1 text-center max-w-xs">
                  Type a message below. It will be created as a subtask for this agent to process.
                </p>
              </div>
              <div className="flex gap-2">
                <Input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendInstruction();
                    }
                  }}
                  placeholder="Type an instruction for this agent..."
                  className="flex-1"
                />
                <Button
                  onClick={handleSendInstruction}
                  disabled={!instruction.trim() || createSubtask.isPending}
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
              {createSubtask.isSuccess && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2">
                  Instruction sent successfully.
                </p>
              )}
              {createSubtask.isError && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                  Failed to send instruction. Try again.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── TIMELINE ITEM ──────────────────────────────────────────────

function TimelineItem({ event }: { event: AgentEvent }) {
  const meta = EVENT_META[event.eventType] || EVENT_META['agent.status_changed'];
  const Icon = meta.icon;

  return (
    <div className="flex items-start gap-3 py-2 px-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
      <div className={cn('mt-0.5 flex-shrink-0', meta.color)}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
            {meta.label}
          </span>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          {describeEvent(event)}
        </p>
      </div>
      <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 flex-shrink-0 tabular-nums mt-0.5">
        {formatTime(event.timestamp)}
      </span>
    </div>
  );
}

function describeEvent(event: AgentEvent): string {
  switch (event.eventType) {
    case 'agent.task_assigned':
      return `Assigned to stage "${event.data.stageName || 'unknown'}"`;
    case 'agent.task_started':
      return 'Started working on task';
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
        ? ` (${(Number(event.data.percentUsed) * 100).toFixed(0)}% used)`
        : '';
      return `Budget warning${pct}`;
    }
    case 'agent.budget_exceeded':
      return 'Budget exceeded — agent halted';
    default:
      return 'Unknown event';
  }
}
