'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useDepartmentTree } from '@/lib/hooks/use-agents';
import type { DelegationTarget } from '@/lib/hooks/use-agents';
import { StatusIndicator } from './status-indicator';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Brain, Hammer, Shield, FileText, Users,
} from 'lucide-react';

// ─── CONSTANTS ──────────────────────────────────────────────────

const DEPT_ICONS: Record<string, typeof Brain> = {
  discovery: Brain,
  execution: Hammer,
  qa: Shield,
  pm: FileText,
};

const ROLE_COLORS: Record<string, string> = {
  director: 'border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/10',
  lead: 'border-primary-300 dark:border-primary-700 bg-primary-50 dark:bg-primary-900/10',
  specialist: 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50',
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  director: 'bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
  lead: 'bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400',
  specialist: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
};

// ─── ORG CHART NODE ─────────────────────────────────────────────

function OrgChartNode({ agent }: { agent: DelegationTarget }) {
  return (
    <Link href={`/agents/${agent.id}`}>
      <div
        className={cn(
          'relative flex items-center gap-2.5 px-3 py-2.5 rounded-lg border transition-all hover:shadow-md cursor-pointer',
          ROLE_COLORS[agent.role] || ROLE_COLORS.specialist,
        )}
      >
        <StatusIndicator status={agent.status} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-50 truncate">
            {agent.name}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
            {agent.slug}
          </p>
        </div>
        <Badge className={cn('text-[10px] shrink-0', ROLE_BADGE_COLORS[agent.role] || ROLE_BADGE_COLORS.specialist)}>
          {agent.role}
        </Badge>
      </div>
    </Link>
  );
}

// ─── CONNECTOR LINES ────────────────────────────────────────────

function BranchConnector({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="relative flex justify-center py-1">
      {/* Vertical stem */}
      <div className="w-px h-4 bg-slate-300 dark:bg-slate-600" />
      {/* Horizontal branch spanning all children */}
      {count > 1 && (
        <div
          className="absolute bottom-0 h-px bg-slate-300 dark:bg-slate-600"
          style={{
            width: `calc(${Math.min(count, 4) - 1} * (100% / ${Math.min(count, 4)}))`,
            left: `calc(50% - (${Math.min(count, 4) - 1} * (100% / ${Math.min(count, 4)})) / 2)`,
          }}
        />
      )}
    </div>
  );
}

// ─── ORG CHART ──────────────────────────────────────────────────

interface OrgChartProps {
  department: string;
  className?: string;
}

export function OrgChart({ department, className }: OrgChartProps) {
  const { data: agents, isLoading } = useDepartmentTree(department);

  // Build structured tree from the flat agent list.
  // The API returns DelegationTarget[] — group by role into { director, leads, specialists }.
  const tree = (() => {
    if (!agents || !Array.isArray(agents) || agents.length === 0) return null;
    const deptAgents = agents.filter((a: any) => a.department === department);
    const director = deptAgents.find((a: any) => a.role === 'director') || null;
    const leads = deptAgents.filter((a: any) => a.role === 'lead');
    const specialists = deptAgents.filter((a: any) => a.role === 'specialist');
    if (!director && leads.length === 0 && specialists.length === 0) return null;
    return { director, leads, specialists };
  })();

  const Icon = DEPT_ICONS[department] || Brain;

  if (isLoading) {
    return (
      <Card className={cn('bg-white dark:bg-slate-800 p-6', className)}>
        <div className="animate-pulse space-y-4">
          <div className="h-5 bg-slate-200 dark:bg-slate-700 rounded w-1/3 mx-auto" />
          <div className="h-12 bg-slate-200 dark:bg-slate-700 rounded w-48 mx-auto" />
          <div className="flex justify-center gap-4">
            <div className="h-12 bg-slate-200 dark:bg-slate-700 rounded w-36" />
            <div className="h-12 bg-slate-200 dark:bg-slate-700 rounded w-36" />
          </div>
          <div className="flex justify-center gap-3">
            <div className="h-12 bg-slate-200 dark:bg-slate-700 rounded w-32" />
            <div className="h-12 bg-slate-200 dark:bg-slate-700 rounded w-32" />
            <div className="h-12 bg-slate-200 dark:bg-slate-700 rounded w-32" />
          </div>
        </div>
      </Card>
    );
  }

  if (!tree) {
    return (
      <Card className={cn('bg-white dark:bg-slate-800 p-6 text-center', className)}>
        <Users className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No org data available for this department.
        </p>
      </Card>
    );
  }

  return (
    <Card className={cn('bg-white dark:bg-slate-800 p-6 overflow-x-auto', className)}>
      {/* Department Label */}
      <div className="flex items-center justify-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-slate-400" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 uppercase tracking-wide">
          {department} Department
        </h3>
      </div>

      <div className="flex flex-col items-center min-w-[400px]">
        {/* Director */}
        {tree.director && (
          <div className="w-56">
            <OrgChartNode agent={tree.director} />
          </div>
        )}

        {/* Director → Leads connector */}
        {tree.director && tree.leads.length > 0 && (
          <BranchConnector count={tree.leads.length} />
        )}

        {/* Leads row */}
        {tree.leads.length > 0 && (
          <div className="flex flex-wrap justify-center gap-3">
            {tree.leads.map((lead) => (
              <div key={lead.id} className="flex flex-col items-center">
                {/* Vertical connector from branch to each lead */}
                <div className="w-px h-3 bg-slate-300 dark:bg-slate-600" />
                <div className="w-48">
                  <OrgChartNode agent={lead} />
                </div>

                {/* Lead → Specialists connector */}
                {tree.specialists.length > 0 && (
                  <div className="flex justify-center py-1">
                    <div className="w-px h-4 bg-slate-300 dark:bg-slate-600" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Specialists row */}
        {tree.specialists.length > 0 && (
          <>
            {tree.leads.length > 0 && (
              <div className="w-full flex justify-center mb-1">
                <div
                  className="h-px bg-slate-300 dark:bg-slate-600"
                  style={{
                    width: `${Math.min(tree.specialists.length * 180, 720)}px`,
                  }}
                />
              </div>
            )}
            <div className="flex flex-wrap justify-center gap-3">
              {tree.specialists.map((specialist) => (
                <div key={specialist.id} className="flex flex-col items-center">
                  {tree.leads.length > 0 && (
                    <div className="w-px h-3 bg-slate-300 dark:bg-slate-600" />
                  )}
                  <div className="w-44">
                    <OrgChartNode agent={specialist} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
