'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { OrgChart } from './org-chart';
import type { AgentDashboard } from '@/lib/hooks/use-agents';
import {
  Brain, Hammer, Shield, FileText,
  Users, ChevronDown, ChevronUp,
  DollarSign, Activity,
} from 'lucide-react';

// ─── CONSTANTS ──────────────────────────────────────────────────

const DEPARTMENTS = ['discovery', 'execution', 'qa', 'pm'] as const;

const DEPT_META: Record<string, {
  icon: typeof Brain;
  color: string;
  bgColor: string;
  label: string;
  description: string;
}> = {
  discovery: {
    icon: Brain,
    color: 'text-purple-500',
    bgColor: 'bg-purple-100 dark:bg-purple-900/20',
    label: 'Discovery',
    description: 'Intent extraction & capability mining',
  },
  execution: {
    icon: Hammer,
    color: 'text-blue-500',
    bgColor: 'bg-blue-100 dark:bg-blue-900/20',
    label: 'Execution',
    description: 'Code transformation & co-creation',
  },
  qa: {
    icon: Shield,
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-100 dark:bg-emerald-900/20',
    label: 'QA',
    description: 'Behavior lock-in & validation',
  },
  pm: {
    icon: FileText,
    color: 'text-amber-500',
    bgColor: 'bg-amber-100 dark:bg-amber-900/20',
    label: 'PM',
    description: 'Project management & coordination',
  },
};

// ─── COMPONENT ──────────────────────────────────────────────────

interface DepartmentCardsProps {
  dashboard: AgentDashboard;
  agents: Array<{ department: string; status: string; spent_monthly_cents: number }>;
}

export function DepartmentCards({ dashboard, agents }: DepartmentCardsProps) {
  const [expandedDept, setExpandedDept] = useState<string | null>(null);

  const toggleDept = (dept: string) => {
    setExpandedDept((prev) => (prev === dept ? null : dept));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {DEPARTMENTS.map((dept) => {
          const meta = DEPT_META[dept];
          const Icon = meta.icon;
          const deptAgents = agents.filter((a) => a.department === dept);
          const agentCount = dashboard.byDepartment[dept] || 0;
          const workingCount = deptAgents.filter((a) => a.status === 'working').length;
          const idleCount = deptAgents.filter((a) => a.status === 'idle').length;
          const pausedCount = deptAgents.filter((a) => a.status === 'paused').length;
          const totalSpend = deptAgents.reduce((sum, a) => sum + a.spent_monthly_cents, 0);
          const isExpanded = expandedDept === dept;

          return (
            <div key={dept}>
              <Card
                className={cn(
                  'bg-white dark:bg-slate-800 p-4 transition-all cursor-pointer hover:shadow-md',
                  isExpanded && 'ring-2 ring-primary-300 dark:ring-primary-700',
                )}
                onClick={() => toggleDept(dept)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', meta.bgColor, meta.color)}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">
                        {meta.label}
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {meta.description}
                      </p>
                    </div>
                  </div>
                  <button className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors p-1">
                    {isExpanded
                      ? <ChevronUp className="w-4 h-4" />
                      : <ChevronDown className="w-4 h-4" />
                    }
                  </button>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-4 gap-3 mt-4">
                  <div>
                    <div className="flex items-center gap-1 mb-0.5">
                      <Users className="w-3 h-3 text-slate-400" />
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Agents</span>
                    </div>
                    <p className="text-lg font-bold text-slate-900 dark:text-slate-50">
                      {agentCount}
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 mb-0.5">
                      <Activity className="w-3 h-3 text-blue-500" />
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Active</span>
                    </div>
                    <p className="text-lg font-bold text-blue-600 dark:text-blue-400">
                      {workingCount}
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 mb-0.5">
                      <DollarSign className="w-3 h-3 text-slate-400" />
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Spend</span>
                    </div>
                    <p className="text-lg font-bold text-slate-900 dark:text-slate-50">
                      ${(totalSpend / 100).toFixed(0)}
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Status</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {idleCount > 0 && (
                        <Badge className="bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-[10px] px-1.5 py-0">
                          {idleCount}
                        </Badge>
                      )}
                      {workingCount > 0 && (
                        <Badge className="bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 text-[10px] px-1.5 py-0">
                          {workingCount}
                        </Badge>
                      )}
                      {pausedCount > 0 && (
                        <Badge className="bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-[10px] px-1.5 py-0">
                          {pausedCount}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </Card>

              {/* Expanded Org Chart */}
              {isExpanded && (
                <div className="mt-3 animate-in slide-in-from-top-2 duration-200">
                  <OrgChart department={dept} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
