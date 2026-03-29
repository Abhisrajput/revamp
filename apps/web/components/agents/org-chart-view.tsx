'use client';

import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Brain, Hammer, Shield, FileText, Network, ChevronDown, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';

interface OrgAgent {
  id: string;
  name: string;
  slug: string;
  role: string;
  department: string;
  status: string;
  reports_to: string | null;
  preferred_model?: string;
  preferred_provider?: string;
  can_delegate: boolean;
  children: OrgAgent[];
}

const DEPT_CONFIG: Record<string, { icon: typeof Brain; color: string; bg: string; border: string }> = {
  discovery: { icon: Brain, color: 'text-purple-500', bg: 'bg-purple-50 dark:bg-purple-950/20', border: 'border-purple-300 dark:border-purple-700' },
  execution: { icon: Hammer, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/20', border: 'border-blue-300 dark:border-blue-700' },
  qa: { icon: Shield, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/20', border: 'border-emerald-300 dark:border-emerald-700' },
  pm: { icon: FileText, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-950/20', border: 'border-amber-300 dark:border-amber-700' },
};

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-emerald-400',
  working: 'bg-cyan-400',
  paused: 'bg-amber-400',
  disabled: 'bg-slate-400',
};

export const OrgChartView = memo(function OrgChartView() {
  const { data, isLoading } = useQuery<{ roots: OrgAgent[]; total: number; departments: string[] }>({
    queryKey: ['agents-org-chart'],
    queryFn: async () => (await apiClient.get('/agents/org-chart')).data,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const roots = data?.roots || [];

  if (roots.length === 0) {
    return (
      <Card className="bg-white dark:bg-slate-800 p-12 text-center">
        <Network className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
        <p className="text-sm text-slate-500">No agents with reporting structure</p>
        <p className="text-xs text-slate-400 mt-1">Set "Reports To" on agents to build the hierarchy</p>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Organization Chart</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {data?.total || 0} agents across {data?.departments?.length || 0} departments
        </p>
      </div>

      {/* Department legend */}
      <div className="flex items-center gap-4">
        {Object.entries(DEPT_CONFIG).map(([dept, cfg]) => {
          const Icon = cfg.icon;
          return (
            <div key={dept} className="flex items-center gap-1.5 text-xs">
              <Icon className={cn('w-3.5 h-3.5', cfg.color)} />
              <span className="text-slate-500 capitalize">{dept}</span>
            </div>
          );
        })}
      </div>

      {/* Tree */}
      <div className="overflow-x-auto">
        <div className="inline-flex flex-col items-center min-w-full">
          {roots.map(root => (
            <OrgNode key={root.id} agent={root} depth={0} />
          ))}
        </div>
      </div>
    </div>
  );
});

function OrgNode({ agent, depth }: { agent: OrgAgent; depth: number }) {
  const cfg = DEPT_CONFIG[agent.department] || DEPT_CONFIG.discovery;
  const Icon = cfg.icon;
  const hasChildren = agent.children && agent.children.length > 0;
  const isWorking = agent.status === 'working';

  return (
    <div className="flex flex-col items-center">
      {/* Node card */}
      <div className={cn(
        'relative rounded-xl border-2 p-4 min-w-[180px] transition-all duration-300',
        'bg-white dark:bg-slate-800/90',
        cfg.border,
        isWorking && 'shadow-[0_8px_30px_rgba(6,182,212,0.08)]',
        depth === 0 && 'min-w-[220px]',
      )}>
        {/* Status dot */}
        <div className="absolute -top-1 -right-1">
          <span className={cn('w-3 h-3 rounded-full block border-2 border-white dark:border-slate-800', STATUS_DOT[agent.status] || STATUS_DOT.disabled)}>
            {isWorking && <span className={cn('absolute inset-0 rounded-full animate-ping opacity-75', STATUS_DOT.working)} />}
          </span>
        </div>

        <div className="flex items-center gap-2.5 mb-2">
          <div className={cn('p-1.5 rounded-lg', cfg.bg)}>
            <Icon className={cn('w-4 h-4', cfg.color)} />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">{agent.name}</p>
            <p className="text-[9px] text-slate-400 font-mono">{agent.slug}</p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 mb-1.5">
          <Badge className="text-[8px] px-1.5 py-0 bg-slate-100 dark:bg-slate-700 text-slate-500 capitalize">{agent.role}</Badge>
          <Badge className={cn('text-[8px] px-1.5 py-0', cfg.bg, cfg.color)}>{agent.department}</Badge>
        </div>

        {agent.preferred_model && (
          <p className="text-[9px] text-slate-400 font-mono truncate">{agent.preferred_model}</p>
        )}

        {agent.can_delegate && (
          <div className="flex items-center gap-1 mt-1.5 text-[9px] text-cyan-500">
            <ChevronDown className="w-2.5 h-2.5" />
            Can delegate
          </div>
        )}
      </div>

      {/* Connector line + children */}
      {hasChildren && (
        <>
          <div className="w-px h-6 bg-slate-300 dark:bg-slate-600" />
          <div className="flex items-start gap-6">
            {agent.children.map((child, i) => (
              <div key={child.id} className="flex flex-col items-center relative">
                {/* Horizontal connector */}
                {agent.children.length > 1 && (
                  <div className={cn(
                    'absolute top-0 h-px bg-slate-300 dark:bg-slate-600',
                    i === 0 ? 'left-1/2 right-0' :
                      i === agent.children.length - 1 ? 'left-0 right-1/2' :
                      'left-0 right-0',
                  )} style={{ width: i === 0 || i === agent.children.length - 1 ? '50%' : '100%', ...(i === 0 ? { left: '50%' } : i === agent.children.length - 1 ? { right: '50%' } : {}) }} />
                )}
                <div className="w-px h-6 bg-slate-300 dark:bg-slate-600" />
                <OrgNode agent={child} depth={depth + 1} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
