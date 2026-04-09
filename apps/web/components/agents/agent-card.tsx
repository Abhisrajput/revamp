'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { BudgetBar } from './budget-bar';
import { StatusIndicator } from './status-indicator';
import type { AgentPersona } from '@/lib/hooks/use-agents';
import {
  Brain, Shield, Hammer, FileText, ChevronRight,
} from 'lucide-react';

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

const ROLE_COLORS: Record<string, string> = {
  director: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  lead: 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400',
  specialist: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
};

interface AgentCardProps {
  agent: AgentPersona;
}

export function AgentCard({ agent }: AgentCardProps) {
  const dept = DEPT_META[agent.department] || DEPT_META.discovery;
  const DeptIcon = dept.icon;

  return (
    <Link href={`/agents/${agent.id}`}>
      <Card className="bg-white dark:bg-slate-800 p-4 hover:border-primary-300 dark:hover:border-primary-700 transition-colors cursor-pointer group">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className={`relative w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-700 flex items-center justify-center ${dept.color}`}>
              <DeptIcon className="w-4 h-4" />
              <StatusIndicator
                status={agent.status}
                size="sm"
                className="absolute -top-0.5 -right-0.5"
              />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 leading-tight">
                {agent.name}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                {agent.slug}
              </p>
            </div>
          </div>
          <ChevronRight className="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:text-primary-500 transition-colors" />
        </div>

        {/* Badges */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          <Badge className={STATUS_COLORS[agent.status] || STATUS_COLORS.idle}>
            {agent.status}
          </Badge>
          <Badge className={ROLE_COLORS[agent.role] || ROLE_COLORS.specialist}>
            {agent.role}
          </Badge>
          <Badge className="bg-slate-50 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300">
            {dept.label}
          </Badge>
        </div>

        {/* Model */}
        {agent.preferred_model && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3 truncate">
            Model: <span className="font-mono">{agent.preferred_model}</span>
          </p>
        )}

        {/* Budget */}
        <BudgetBar
          spentCents={agent.spent_monthly_cents}
          limitCents={agent.monthly_budget_cents ?? 0}
          warningThreshold={parseFloat(String(agent.warning_threshold ?? '0.8'))}
          hardStop={agent.hard_stop_enabled ?? false}
          compact
        />

        {/* Skills count */}
        <div className="flex items-center justify-between mt-3 text-xs text-slate-500 dark:text-slate-400">
          <span>{(agent.skills ?? []).length} skills</span>
          <span>{(agent.stage_permissions ?? []).length} stages</span>
        </div>
      </Card>
    </Link>
  );
}
