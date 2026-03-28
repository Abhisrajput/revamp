'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useAgentReportingChain, useAgentSubordinates } from '@/lib/hooks/use-agents';
import type { DelegationTarget } from '@/lib/hooks/use-agents';
import { StatusIndicator } from './status-indicator';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowUp, ArrowDown,
} from 'lucide-react';

// ─── ROLE BADGE COLORS ──────────────────────────────────────────

const ROLE_BADGE: Record<string, string> = {
  director: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  lead: 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400',
  specialist: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
};

// ─── CHAIN ITEM ─────────────────────────────────────────────────

function ChainAgent({ agent, isCurrent }: { agent: DelegationTarget; isCurrent?: boolean }) {
  return (
    <Link href={`/agents/${agent.id}`}>
      <div
        className={cn(
          'flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/30 cursor-pointer',
          isCurrent && 'bg-primary-50 dark:bg-primary-900/10 ring-1 ring-primary-200 dark:ring-primary-800',
        )}
      >
        <StatusIndicator status={agent.status} size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-50 truncate">
            {agent.name}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
            {agent.slug}
          </p>
        </div>
        <Badge className={cn('text-[10px]', ROLE_BADGE[agent.role] || ROLE_BADGE.specialist)}>
          {agent.role}
        </Badge>
      </div>
    </Link>
  );
}

// ─── REPORTING CHAIN ────────────────────────────────────────────

interface ReportingChainProps {
  agentId: string;
  agentName: string;
  className?: string;
}

export function ReportingChain({ agentId, agentName, className }: ReportingChainProps) {
  const { data: chain, isLoading } = useAgentReportingChain(agentId);

  if (isLoading) {
    return (
      <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/3" />
          <div className="h-10 bg-slate-200 dark:bg-slate-700 rounded" />
          <div className="h-10 bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      </Card>
    );
  }

  if (!chain || chain.length === 0) return null;

  return (
    <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
      <div className="flex items-center gap-2 mb-4">
        <ArrowUp className="w-4 h-4 text-slate-400" />
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
          Reporting Chain
        </h2>
      </div>

      <div className="space-y-1">
        {/* Chain is from immediate supervisor up to director, so render in reverse
            (director first) for a top-down view */}
        {[...chain].reverse().map((agent, index) => (
          <div key={agent.id}>
            <ChainAgent agent={agent} />
            {index < chain.length - 1 && (
              <div className="flex justify-center py-0.5">
                <div className="w-px h-3 bg-slate-200 dark:bg-slate-700" />
              </div>
            )}
          </div>
        ))}

        {/* Current agent marker */}
        <div className="flex justify-center py-0.5">
          <div className="w-px h-3 bg-slate-200 dark:bg-slate-700" />
        </div>
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-primary-50 dark:bg-primary-900/10 ring-1 ring-primary-200 dark:ring-primary-800">
          <div className="w-2.5 h-2.5 rounded-full bg-primary-500" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-primary-700 dark:text-primary-300 truncate">
              {agentName}
            </p>
            <p className="text-xs text-primary-600/60 dark:text-primary-400/60">
              (current)
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── SUBORDINATES ───────────────────────────────────────────────

interface SubordinatesProps {
  agentId: string;
  className?: string;
}

export function Subordinates({ agentId, className }: SubordinatesProps) {
  const { data: subordinates, isLoading } = useAgentSubordinates(agentId);

  if (isLoading) {
    return (
      <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-1/3" />
          <div className="h-10 bg-slate-200 dark:bg-slate-700 rounded" />
          <div className="h-10 bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      </Card>
    );
  }

  if (!subordinates || subordinates.length === 0) return null;

  return (
    <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ArrowDown className="w-4 h-4 text-slate-400" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            Subordinates
          </h2>
        </div>
        <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
          {subordinates.length}
        </Badge>
      </div>

      <div className="space-y-1">
        {subordinates.map((agent) => (
          <ChainAgent key={agent.id} agent={agent} />
        ))}
      </div>
    </Card>
  );
}
