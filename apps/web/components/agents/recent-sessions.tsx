'use client';

import { cn } from '@/lib/utils';
import { useAgentSessions } from '@revamp/core';
import type { SessionChainEntry } from '@revamp/core';
import { Card } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import {
  MessageSquare, Hash, FileText, AlertTriangle, CheckCircle2,
} from 'lucide-react';

// ─── SESSION ITEM ───────────────────────────────────────────────

function SessionItem({ session }: { session: SessionChainEntry }) {
  const data = session.sessionData as {
    findings?: string[];
    decisions?: Array<{ decision: string; rationale?: string }>;
    warnings?: string[];
  } | null | undefined;
  const findingsCount = data?.findings?.length ?? 0;
  const decisionsCount = data?.decisions?.length ?? 0;
  const warningsCount = data?.warnings?.length ?? 0;
  const hasContent = findingsCount > 0 || decisionsCount > 0 || warningsCount > 0 || session.compactionSummary;

  return (
    <div className="px-3 py-3 rounded-lg border border-slate-100 dark:border-slate-700/50 hover:border-slate-200 dark:hover:border-slate-700 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Hash className="w-3 h-3 text-slate-400" />
          <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
            {session.id.slice(0, 8)}
          </span>
          {session.compacted && (
            <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 text-[10px] px-1.5 py-0">
              compacted
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">
            {(session.tokenCount ?? 0).toLocaleString()} tokens
          </span>
          <span className="text-[10px] text-slate-400 dark:text-slate-500">
            {new Date(session.createdAt ?? session.started_at).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Compaction summary */}
      {session.compactionSummary && (
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed mb-2 line-clamp-2">
          {session.compactionSummary}
        </p>
      )}

      {/* Session data summary */}
      {!session.compacted && hasContent && (
        <div className="space-y-1.5">
          {/* Findings */}
          {data?.findings && data.findings.length > 0 && (
            <div className="flex items-start gap-2">
              <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-0.5 shrink-0" />
              <div className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
                {data.findings.slice(0, 2).join('; ')}
                {data.findings.length > 2 && ` (+${data.findings.length - 2} more)`}
              </div>
            </div>
          )}

          {/* Decisions */}
          {data?.decisions && data.decisions.length > 0 && (
            <div className="flex items-start gap-2">
              <FileText className="w-3 h-3 text-blue-500 mt-0.5 shrink-0" />
              <div className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
                {data.decisions.slice(0, 2).map((d) => d.decision).join('; ')}
                {data.decisions.length > 2 && ` (+${data.decisions.length - 2} more)`}
              </div>
            </div>
          )}

          {/* Warnings */}
          {data?.warnings && data.warnings.length > 0 && (
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
              <div className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
                {data.warnings.slice(0, 2).join('; ')}
                {data.warnings.length > 2 && ` (+${data.warnings.length - 2} more)`}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stats badges */}
      {!session.compacted && hasContent && (
        <div className="flex gap-1.5 mt-2">
          {findingsCount > 0 && (
            <Badge className="bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 text-[10px] px-1.5 py-0">
              {findingsCount} findings
            </Badge>
          )}
          {decisionsCount > 0 && (
            <Badge className="bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 text-[10px] px-1.5 py-0">
              {decisionsCount} decisions
            </Badge>
          )}
          {warningsCount > 0 && (
            <Badge className="bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-[10px] px-1.5 py-0">
              {warningsCount} warnings
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RECENT SESSIONS ────────────────────────────────────────────

interface RecentSessionsProps {
  agentId: string;
  className?: string;
}

export function RecentSessions({ agentId, className }: RecentSessionsProps) {
  const { data: sessions, isLoading } = useAgentSessions(agentId, 5);

  if (isLoading) {
    return (
      <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/3" />
          <div className="h-16 bg-slate-200 dark:bg-slate-700 rounded" />
          <div className="h-16 bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      </Card>
    );
  }

  if (!sessions || sessions.length === 0) return null;

  return (
    <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            Recent Sessions
          </h2>
        </div>
        <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
          {sessions.length}
        </Badge>
      </div>

      <div className="space-y-2">
        {sessions.map((session) => (
          <SessionItem key={session.id} session={session} />
        ))}
      </div>
    </Card>
  );
}
