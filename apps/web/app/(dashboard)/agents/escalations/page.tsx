/**
 * Escalation Manager Page — dedicated page showing all escalated tasks across agents.
 *
 * Features:
 * - Table view of all escalated assignments
 * - Filter by department
 * - Approve / Reject / Reassign actions
 */

'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useEscalatedAssignments,
  useApproveEscalation,
  useRejectEscalation,
  type EscalatedAssignment,
} from '@/lib/hooks/use-agents';
import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Brain,
  Hammer,
  Shield,
  FileText,
  Clock,
  RefreshCw,
} from 'lucide-react';

// ─── CONSTANTS ──────────────────────────────────────────────────

const DEPARTMENTS = ['all', 'discovery', 'execution', 'qa', 'pm'] as const;

const DEPT_META: Record<string, { icon: typeof Brain; color: string; label: string }> = {
  discovery: { icon: Brain, color: 'text-purple-500', label: 'Discovery' },
  execution: { icon: Hammer, color: 'text-blue-500', label: 'Execution' },
  qa: { icon: Shield, color: 'text-emerald-500', label: 'QA' },
  pm: { icon: FileText, color: 'text-amber-500', label: 'PM' },
};

const ROLE_COLORS: Record<string, string> = {
  director: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  lead: 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400',
  specialist: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
};

// ─── HELPERS ────────────────────────────────────────────────────

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

// ─── PAGE ───────────────────────────────────────────────────────

export default function EscalationsPage() {
  const [department, setDepartment] = useState<string>('all');

  const { data: escalations, isLoading, refetch } = useEscalatedAssignments({
    department: department !== 'all' ? department : undefined,
  });

  const approveEscalation = useApproveEscalation();
  const rejectEscalation = useRejectEscalation();

  const handleApprove = useCallback((agentId: string) => {
    approveEscalation.mutate(agentId);
  }, [approveEscalation]);

  const handleReject = useCallback((assignmentId: string) => {
    rejectEscalation.mutate({
      assignmentId,
      result: { rejected: true, reason: 'Rejected by human operator' },
    });
  }, [rejectEscalation]);

  const pendingCount = escalations?.length ?? 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link
            href="/agents"
            className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
                Escalation Manager
              </h1>
              {pendingCount > 0 && (
                <Badge className="bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                  {pendingCount} pending
                </Badge>
              )}
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              Review and resolve escalated tasks from AI agents
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          className="text-xs"
        >
          <RefreshCw className="w-3.5 h-3.5 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Department Filter */}
      <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1 mb-6 w-fit">
        {DEPARTMENTS.map((d) => (
          <button
            key={d}
            onClick={() => setDepartment(d)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize',
              department === d
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-50 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
            )}
          >
            {d}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="bg-white dark:bg-slate-800 p-5 animate-pulse">
              <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/3 mb-3" />
              <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-2/3 mb-2" />
              <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2" />
            </Card>
          ))}
        </div>
      ) : escalations && escalations.length > 0 ? (
        <div className="space-y-3">
          {escalations.map((esc) => (
            <EscalationRow
              key={esc.id}
              escalation={esc}
              onApprove={handleApprove}
              onReject={handleReject}
              approving={approveEscalation.isPending}
              rejecting={rejectEscalation.isPending}
            />
          ))}
        </div>
      ) : (
        <Card className="bg-white dark:bg-slate-800 p-12 text-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-300 dark:text-emerald-600 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-1">
            All clear
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {department !== 'all'
              ? `No escalated tasks in the ${department} department.`
              : 'No escalated tasks across any agents.'}
          </p>
        </Card>
      )}
    </div>
  );
}

// ─── ESCALATION ROW ─────────────────────────────────────────────

interface EscalationRowProps {
  escalation: EscalatedAssignment;
  onApprove: (agentId: string) => void;
  onReject: (assignmentId: string) => void;
  approving: boolean;
  rejecting: boolean;
}

function EscalationRow({ escalation, onApprove, onReject, approving, rejecting }: EscalationRowProps) {
  const dept = escalation.agent ? (DEPT_META[escalation.agent.department] || DEPT_META.discovery) : null;
  const DeptIcon = dept?.icon || Brain;

  return (
    <Card className="bg-white dark:bg-slate-800 p-5 border-l-4 border-l-amber-400 dark:border-l-amber-500">
      <div className="flex items-start gap-4">
        {/* Agent Info */}
        <div className={cn('w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center flex-shrink-0', dept?.color || 'text-slate-400')}>
          <DeptIcon className="w-4.5 h-4.5" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1.5">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {escalation.agent?.name ?? 'Unknown Agent'}
            </span>
            {escalation.agent && (
              <Badge className={ROLE_COLORS[escalation.agent.role] || ROLE_COLORS.specialist}>
                {escalation.agent.role}
              </Badge>
            )}
            {dept && (
              <Badge className="bg-slate-50 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300">
                {dept.label}
              </Badge>
            )}
          </div>

          {/* Stage */}
          <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 mb-2">
            {escalation.stage_name && (
              <span>
                Stage: <span className="font-mono text-slate-700 dark:text-slate-300">{escalation.stage_name}</span>
              </span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDate(escalation.updated_at ?? escalation.created_at)}
            </span>
          </div>

          {/* Reason */}
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/40 mb-3">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
              {escalation.error_message || 'No reason provided'}
            </p>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => onApprove(escalation.agent_id)}
              disabled={approving}
              className="text-xs"
            >
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              {approving ? 'Approving...' : 'Approve & Resume'}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onReject(escalation.id)}
              disabled={rejecting}
              className="text-xs"
            >
              <XCircle className="w-3.5 h-3.5 mr-1" />
              {rejecting ? 'Rejecting...' : 'Reject'}
            </Button>
          </div>
        </div>

        {/* Time Ago */}
        <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 tabular-nums flex-shrink-0">
          {formatRelative(escalation.updated_at ?? escalation.created_at)}
        </span>
      </div>
    </Card>
  );
}
