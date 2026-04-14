/**
 * Agent Task View — shows current and recent tasks for an agent.
 *
 * Features:
 * - Current task: stage name, pipeline run, progress indicator, cost
 * - Subtasks: list of subtasks with status badges
 * - Session context: collapsible section showing accumulated knowledge
 */

'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import {
  useAgentSubtasks,
  useAgentSessions,
  type AgentPersona,
  type AgentSubtask,
} from '@revamp/core';
import {
  Briefcase,
  GitBranch,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  CheckCircle2,
  XCircle,
  Loader2,
  FileText,
  Brain,
  Layers,
} from 'lucide-react';

// ─── CONSTANTS ──────────────────────────────────────────────────

const SUBTASK_STATUS_STYLES: Record<string, { color: string; label: string }> = {
  backlog: { color: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400', label: 'Backlog' },
  assigned: { color: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400', label: 'Assigned' },
  in_progress: { color: 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400', label: 'In Progress' },
  completed: { color: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400', label: 'Completed' },
  failed: { color: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400', label: 'Failed' },
};

// ─── HELPERS ────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── COMPONENT ──────────────────────────────────────────────────

interface AgentTasksProps {
  agent: AgentPersona;
  pipelineRunId?: string;
  className?: string;
}

export function AgentTasks({ agent, pipelineRunId, className }: AgentTasksProps) {
  const { data: subtasks, isLoading: subtasksLoading } = useAgentSubtasks(pipelineRunId);
  const { data: sessions, isLoading: sessionsLoading } = useAgentSessions(agent.id, 5);

  return (
    <div className={cn('space-y-4', className)}>
      {/* Current Task */}
      <CurrentTaskCard agent={agent} pipelineRunId={pipelineRunId} />

      {/* Subtasks */}
      <SubtasksCard
        subtasks={subtasks ?? []}
        isLoading={subtasksLoading}
        agentId={agent.id}
      />

      {/* Session Context */}
      <SessionContextCard
        sessions={sessions ?? []}
        isLoading={sessionsLoading}
      />
    </div>
  );
}

// ─── CURRENT TASK CARD ──────────────────────────────────────────

function CurrentTaskCard({ agent, pipelineRunId }: { agent: AgentPersona; pipelineRunId?: string }) {
  const isActive = agent.status === 'working';

  return (
    <Card className="bg-white dark:bg-slate-800">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Briefcase className="w-4 h-4 text-slate-400" />
          <CardTitle className="text-base font-semibold">Current Task</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {isActive ? (
          <div className="space-y-3">
            {/* Progress indicator */}
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-primary-500 animate-spin" />
              <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                Processing...
              </span>
            </div>

            {/* Pipeline info */}
            {pipelineRunId && (
              <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1">
                  <Layers className="w-3 h-3" />
                  Pipeline: <span className="font-mono">{pipelineRunId.slice(0, 8)}...</span>
                </span>
              </div>
            )}

            {/* Cost so far */}
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <DollarSign className="w-3 h-3" />
              Monthly spend: ${(agent.spent_monthly_cents / 100).toFixed(2)}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center py-4 text-slate-400 dark:text-slate-500">
            <Briefcase className="w-6 h-6 mb-2 opacity-50" />
            <p className="text-sm">No active task</p>
            <p className="text-xs mt-0.5">
              Status: <span className="capitalize">{agent.status}</span>
              {agent.pause_reason && ` (${agent.pause_reason})`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── SUBTASKS CARD ──────────────────────────────────────────────

function SubtasksCard({
  subtasks,
  isLoading,
  agentId,
}: {
  subtasks: AgentSubtask[];
  isLoading: boolean;
  agentId: string;
}) {
  // Filter to show subtasks relevant to this agent (created by or assigned to)
  const relevant = subtasks.filter(
    (s) => s.createdByAgentId === agentId || s.assignedAgentId === agentId,
  );

  return (
    <Card className="bg-white dark:bg-slate-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-slate-400" />
            <CardTitle className="text-base font-semibold">Subtasks</CardTitle>
          </div>
          {relevant.length > 0 && (
            <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
              {relevant.length}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 bg-slate-100 dark:bg-slate-700 rounded animate-pulse" />
            ))}
          </div>
        ) : relevant.length === 0 ? (
          <div className="flex flex-col items-center py-4 text-slate-400 dark:text-slate-500">
            <GitBranch className="w-6 h-6 mb-2 opacity-50" />
            <p className="text-sm">No subtasks</p>
          </div>
        ) : (
          <div className="space-y-2">
            {relevant.map((subtask) => (
              <SubtaskRow key={subtask.id} subtask={subtask} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SubtaskRow({ subtask }: { subtask: AgentSubtask }) {
  const statusStyle = SUBTASK_STATUS_STYLES[subtask.status] || SUBTASK_STATUS_STYLES.backlog;
  const isComplete = subtask.status === 'completed';
  const isFailed = subtask.status === 'failed';

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-md bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700/50">
      <div className="flex-shrink-0">
        {isComplete ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        ) : isFailed ? (
          <XCircle className="w-4 h-4 text-red-500" />
        ) : (
          <Clock className="w-4 h-4 text-slate-400" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-50 truncate">
          {subtask.title}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[11px] font-mono text-slate-400">{subtask.stageName}</span>
          {(subtask.costCents ?? 0) > 0 && (
            <span className="text-[11px] text-slate-400">
              ${((subtask.costCents ?? 0) / 100).toFixed(2)}
            </span>
          )}
        </div>
      </div>
      <Badge className={cn('text-[10px] px-1.5 py-0', statusStyle.color)}>
        {statusStyle.label}
      </Badge>
    </div>
  );
}

// ─── SESSION CONTEXT CARD ───────────────────────────────────────

interface SessionEntry {
  id: string;
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  sessionData?: {
    stageContext?: Record<string, unknown>;
    findings?: string[];
    decisions?: Array<{ decision: string; rationale: string }>;
    warnings?: string[];
    custom?: Record<string, unknown>;
  } | null;
  tokenCount?: number;
  compacted?: boolean;
  compactionSummary?: string | null;
  createdAt?: string;
  started_at?: string;
}

function SessionContextCard({
  sessions,
  isLoading,
}: {
  sessions: SessionEntry[] | any[];
  isLoading: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="bg-white dark:bg-slate-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-slate-400" />
          <span className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Session Context
          </span>
          {sessions.length > 0 && (
            <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px]">
              {sessions.length} sessions
            </Badge>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-slate-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-400" />
        )}
      </button>

      {expanded && (
        <CardContent className="pt-0">
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-16 bg-slate-100 dark:bg-slate-700 rounded animate-pulse" />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center py-4 text-slate-400 dark:text-slate-500">
              <FileText className="w-6 h-6 mb-2 opacity-50" />
              <p className="text-sm">No session history</p>
            </div>
          ) : (
            <div className="space-y-3">
              {sessions.map((session) => (
                <SessionEntry key={session.id} session={session} />
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function SessionEntry({ session }: { session: SessionEntry }) {
  const data = session.sessionData;

  return (
    <div className="rounded-md border border-slate-100 dark:border-slate-700/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-slate-400">{session.id.slice(0, 8)}...</span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400">{(session.tokenCount ?? 0).toLocaleString()} tokens</span>
          {session.compacted && (
            <Badge className="bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400 text-[10px]">
              Compacted
            </Badge>
          )}
        </div>
      </div>

      {session.compactionSummary && (
        <p className="text-xs text-slate-600 dark:text-slate-400 mb-2 italic">
          {session.compactionSummary}
        </p>
      )}

      {data?.findings && data.findings.length > 0 && (
        <div className="mb-2">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">Findings</p>
          <ul className="space-y-0.5">
            {data.findings.slice(0, 5).map((f, i) => (
              <li key={i} className="text-xs text-slate-600 dark:text-slate-400 flex items-start gap-1.5">
                <span className="text-emerald-500 mt-1">-</span>
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.decisions && data.decisions.length > 0 && (
        <div className="mb-2">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">Decisions</p>
          <ul className="space-y-1">
            {data.decisions.slice(0, 3).map((d, i) => (
              <li key={i} className="text-xs text-slate-600 dark:text-slate-400">
                <span className="font-medium">{d.decision}</span>
                {d.rationale && (
                  <span className="text-slate-400 dark:text-slate-500"> — {d.rationale}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.warnings && data.warnings.length > 0 && (
        <div>
          <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400 mb-1">Warnings</p>
          <ul className="space-y-0.5">
            {data.warnings.map((w, i) => (
              <li key={i} className="text-xs text-amber-600 dark:text-amber-400">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[10px] text-slate-400 mt-2">{formatDate(session.createdAt ?? session.started_at ?? '')}</p>
    </div>
  );
}
