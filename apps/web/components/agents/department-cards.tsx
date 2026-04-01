'use client';

import { memo } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { AgentDashboard } from '@/lib/hooks/use-agents';
import {
  Brain, Hammer, Shield, FileText,
  Users, DollarSign, Activity, Network,
  ChevronRight,
} from 'lucide-react';

// ─── CONSTANTS ──────────────────────────────────────────────────

const DEPARTMENTS = ['discovery', 'execution', 'qa', 'pm'] as const;

const DEPT_META: Record<string, {
  icon: typeof Brain;
  color: string;
  textColor: string;
  bgColor: string;
  border: string;
  label: string;
  description: string;
}> = {
  discovery: {
    icon: Brain,
    color: 'text-purple-500',
    textColor: 'text-purple-700 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-950/20',
    border: 'border-purple-200 dark:border-purple-800',
    label: 'Discovery',
    description: 'Legacy analysis, architecture & business rules',
  },
  execution: {
    icon: Hammer,
    color: 'text-blue-500',
    textColor: 'text-blue-700 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/20',
    border: 'border-blue-200 dark:border-blue-800',
    label: 'Execution',
    description: 'Code generation & modernization',
  },
  qa: {
    icon: Shield,
    color: 'text-emerald-500',
    textColor: 'text-emerald-700 dark:text-emerald-400',
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/20',
    border: 'border-emerald-200 dark:border-emerald-800',
    label: 'QA & Security',
    description: 'Testing, BDD validation & security audits',
  },
  pm: {
    icon: FileText,
    color: 'text-amber-500',
    textColor: 'text-amber-700 dark:text-amber-400',
    bgColor: 'bg-amber-50 dark:bg-amber-950/20',
    border: 'border-amber-200 dark:border-amber-800',
    label: 'PM',
    description: 'Documentation & project coordination',
  },
};

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-emerald-400',
  working: 'bg-cyan-400 animate-pulse',
  paused: 'bg-amber-400',
  disabled: 'bg-slate-400',
};

const ROLE_BADGE: Record<string, string> = {
  director: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
  lead: 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400',
  specialist: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
};

// ─── TYPES ──────────────────────────────────────────────────────

interface OrgAgent {
  id: string;
  name: string;
  slug: string;
  role: string;
  department: string;
  status: string;
  preferred_model?: string;
  can_delegate: boolean;
  children: OrgAgent[];
}

// ─── COMPONENT ──────────────────────────────────────────────────

interface DepartmentCardsProps {
  dashboard: AgentDashboard;
  agents: Array<{ department: string; status: string; spent_monthly_cents: number }>;
}

export const DepartmentCards = memo(function DepartmentCards({ dashboard, agents }: DepartmentCardsProps) {
  // Fetch the full org chart hierarchy
  const { data: orgData } = useQuery<{ roots: OrgAgent[]; total: number }>({
    queryKey: ['agents-org-chart'],
    queryFn: async () => (await apiClient.get('/agents/org-chart')).data,
    staleTime: 15_000,
  });

  // Build a flat map of all agents in the tree for department grouping
  const deptAgentMap = new Map<string, OrgAgent[]>();
  if (orgData?.roots) {
    function collect(node: OrgAgent) {
      const list = deptAgentMap.get(node.department) || [];
      list.push(node);
      deptAgentMap.set(node.department, list);
      node.children?.forEach(collect);
    }
    orgData.roots.forEach(collect);
  }

  return (
    <div className="space-y-6">
      {/* ─── Department Stats Cards ─── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {DEPARTMENTS.map((dept) => {
          const meta = DEPT_META[dept];
          const Icon = meta.icon;
          const deptAgents = agents.filter((a) => a.department === dept);
          const agentCount = typeof dashboard.byDepartment[dept] === 'number'
            ? dashboard.byDepartment[dept]
            : (dashboard.byDepartment[dept] as any)?.count ?? deptAgents.length;
          const workingCount = deptAgents.filter((a) => a.status === 'working').length;
          const totalSpend = deptAgents.reduce((sum, a) => sum + (a.spent_monthly_cents || 0), 0);

          return (
            <Card key={dept} className={cn('p-4 border-2', meta.border, meta.bgColor)}>
              <div className="flex items-center gap-2.5 mb-3">
                <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center bg-white/60 dark:bg-slate-800/60')}>
                  <Icon className={cn('w-5 h-5', meta.color)} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-50">{meta.label}</h3>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">{meta.description}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="flex items-center gap-1">
                    <Users className="w-3 h-3 text-slate-400" />
                    <span className="text-[9px] text-slate-500 uppercase">Agents</span>
                  </div>
                  <p className="text-lg font-bold text-slate-900 dark:text-slate-50">{agentCount}</p>
                </div>
                <div>
                  <div className="flex items-center gap-1">
                    <Activity className="w-3 h-3 text-blue-400" />
                    <span className="text-[9px] text-slate-500 uppercase">Active</span>
                  </div>
                  <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{workingCount}</p>
                </div>
                <div>
                  <div className="flex items-center gap-1">
                    <DollarSign className="w-3 h-3 text-slate-400" />
                    <span className="text-[9px] text-slate-500 uppercase">Spend</span>
                  </div>
                  <p className="text-lg font-bold text-slate-900 dark:text-slate-50">${(totalSpend / 100).toFixed(0)}</p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* ─── Full Org Chart ─── */}
      {orgData?.roots && orgData.roots.length > 0 && (
        <Card className="bg-white dark:bg-slate-800 p-6">
          <div className="flex items-center gap-2 mb-5">
            <Network className="w-4 h-4 text-slate-400" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
              Organization Hierarchy
            </h2>
            <Badge className="bg-slate-100 dark:bg-slate-700 text-slate-500 text-[10px] ml-auto">
              {orgData.total} agents
            </Badge>
          </div>

          <div className="space-y-8">
            {orgData.roots.map((root) => (
              <HierarchySection key={root.id} agent={root} depth={0} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
});

// ─── HIERARCHY TREE ─────────────────────────────────────────────

function HierarchySection({ agent, depth }: { agent: OrgAgent; depth: number }) {
  const meta = DEPT_META[agent.department] || DEPT_META.discovery;
  const hasChildren = agent.children && agent.children.length > 0;

  return (
    <div className={cn(depth > 0 && 'ml-6 pl-4 border-l-2 border-slate-200 dark:border-slate-700')}>
      {/* Agent row */}
      <Link href={`/agents/${agent.id}`} className="block group">
        <div className={cn(
          'flex items-center gap-3 px-3 py-2 rounded-lg transition-all',
          'hover:bg-slate-50 dark:hover:bg-slate-700/50',
          agent.status === 'working' && 'bg-cyan-50/50 dark:bg-cyan-950/10',
        )}>
          {/* Status dot */}
          <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', STATUS_DOT[agent.status] || STATUS_DOT.disabled)} />

          {/* Department icon (only for directors/leads) */}
          {(agent.role === 'director' || agent.role === 'lead') && (
            <div className={cn('p-1 rounded shrink-0', meta.bgColor)}>
              <meta.icon className={cn('w-3.5 h-3.5', meta.color)} />
            </div>
          )}

          {/* Name */}
          <span className={cn(
            'font-medium truncate',
            agent.role === 'director' ? 'text-sm text-slate-900 dark:text-slate-50' :
            agent.role === 'lead' ? 'text-sm text-slate-800 dark:text-slate-100' :
            'text-xs text-slate-700 dark:text-slate-200',
          )}>
            {agent.name}
          </span>

          {/* Role badge */}
          <Badge className={cn('text-[9px] px-1.5 py-0 shrink-0', ROLE_BADGE[agent.role] || ROLE_BADGE.specialist)}>
            {agent.role}
          </Badge>

          {/* Department badge (when cross-department, like QA under Discovery director) */}
          {depth > 0 && (
            <Badge className={cn('text-[9px] px-1.5 py-0 shrink-0', meta.bgColor, meta.textColor)}>
              {agent.department}
            </Badge>
          )}

          {/* Delegation indicator */}
          {agent.can_delegate && (
            <span className="text-[9px] text-cyan-500 shrink-0">can delegate</span>
          )}

          {/* Children count */}
          {hasChildren && (
            <span className="text-[10px] text-slate-400 ml-auto shrink-0">
              {agent.children.length} report{agent.children.length !== 1 ? 's' : ''}
            </span>
          )}

          <ChevronRight className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        </div>
      </Link>

      {/* Children */}
      {hasChildren && (
        <div className="mt-1 space-y-0.5">
          {agent.children.map((child) => (
            <HierarchySection key={child.id} agent={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
