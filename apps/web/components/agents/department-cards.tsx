'use client';

import { memo, useState, useCallback } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { AgentDashboard } from '@/lib/hooks/use-agents';
import {
  Brain, Hammer, Shield, FileText,
  Users, DollarSign, Activity, Network,
  ChevronDown, ChevronRight, ExternalLink,
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
    icon: Brain, color: 'text-purple-500', textColor: 'text-purple-700 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-950/20', border: 'border-purple-200 dark:border-purple-800',
    label: 'Discovery', description: 'Legacy analysis, architecture & business rules',
  },
  execution: {
    icon: Hammer, color: 'text-blue-500', textColor: 'text-blue-700 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/20', border: 'border-blue-200 dark:border-blue-800',
    label: 'Execution', description: 'Code generation & modernization',
  },
  qa: {
    icon: Shield, color: 'text-emerald-500', textColor: 'text-emerald-700 dark:text-emerald-400',
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/20', border: 'border-emerald-200 dark:border-emerald-800',
    label: 'QA & Security', description: 'Testing, BDD validation & security audits',
  },
  pm: {
    icon: FileText, color: 'text-amber-500', textColor: 'text-amber-700 dark:text-amber-400',
    bgColor: 'bg-amber-50 dark:bg-amber-950/20', border: 'border-amber-200 dark:border-amber-800',
    label: 'PM', description: 'Documentation & project coordination',
  },
};

const STATUS_META: Record<string, { dot: string; ring: string; label: string }> = {
  idle: { dot: 'bg-emerald-500', ring: 'ring-emerald-500/20', label: 'Available' },
  working: { dot: 'bg-cyan-500', ring: 'ring-cyan-500/20', label: 'Working' },
  paused: { dot: 'bg-amber-500', ring: 'ring-amber-500/20', label: 'Paused' },
  disabled: { dot: 'bg-slate-400', ring: 'ring-slate-400/20', label: 'Disabled' },
};

const AVATAR_COLORS: Record<string, string> = {
  director: 'bg-purple-600 text-white',
  lead: 'bg-sky-600 text-white',
  specialist: 'bg-slate-500 dark:bg-slate-600 text-white',
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

// ─── HELPERS ────────────────────────────────────────────────────

/** Extract initials from agent name: "Atlas — Architect Lead" → "AL" */
function getInitials(name: string): string {
  // Strip the "Name — Title" pattern
  const parts = name.includes('—') ? name.split('—') : name.split(' ');
  const words = parts[0].trim().split(/[\s/]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return words[0]?.slice(0, 2).toUpperCase() || '??';
}

/** Short display name: "Atlas — Architect Lead" → "Atlas" for the title, "Architect Lead" for subtitle */
function splitName(name: string): { title: string; subtitle: string } {
  if (name.includes('—')) {
    const [n, ...rest] = name.split('—');
    return { title: n.trim(), subtitle: rest.join('—').trim() };
  }
  if (name.includes(' Specialist')) {
    return { title: name.replace(' Specialist', ''), subtitle: 'Specialist' };
  }
  return { title: name, subtitle: '' };
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────

interface DepartmentCardsProps {
  dashboard: AgentDashboard;
  agents: Array<{ department: string; status: string; spent_monthly_cents: number }>;
}

export const DepartmentCards = memo(function DepartmentCards({ dashboard, agents }: DepartmentCardsProps) {
  const { data: orgData } = useQuery<{ roots: OrgAgent[]; total: number }>({
    queryKey: ['agents-org-chart'],
    queryFn: async () => (await apiClient.get('/agents/org-chart')).data,
    staleTime: 15_000,
  });

  return (
    <div className="space-y-6">
      {/* ─── Department Stats ─── */}
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
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-white/60 dark:bg-slate-800/60">
                  <Icon className={cn('w-5 h-5', meta.color)} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-50">{meta.label}</h3>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400">{meta.description}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat icon={Users} label="Agents" value={agentCount} />
                <Stat icon={Activity} label="Active" value={workingCount} color="text-blue-600 dark:text-blue-400" />
                <Stat icon={DollarSign} label="Spend" value={`$${(totalSpend / 100).toFixed(0)}`} />
              </div>
            </Card>
          );
        })}
      </div>

      {/* ─── Teams-Style Org Chart ─── */}
      {orgData?.roots && orgData.roots.length > 0 && (
        <Card className="bg-white dark:bg-slate-800/80 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Network className="w-4 h-4 text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Organization</h2>
            <span className="text-xs text-slate-400 ml-auto">{orgData.total} agents</span>
          </div>
          <div className="space-y-1">
            {orgData.roots.map((root) => (
              <OrgNode key={root.id} agent={root} level={0} defaultOpen />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
});

// ─── STAT CELL ──────────────────────────────────────────────────

function Stat({ icon: Icon, label, value, color }: {
  icon: typeof Users; label: string; value: string | number; color?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1">
        <Icon className="w-3 h-3 text-slate-400" />
        <span className="text-[9px] text-slate-500 uppercase">{label}</span>
      </div>
      <p className={cn('text-lg font-bold text-slate-900 dark:text-slate-50', color)}>{value}</p>
    </div>
  );
}

// ─── TEAMS-STYLE ORG NODE ───────────────────────────────────────

function OrgNode({ agent, level, defaultOpen = false }: {
  agent: OrgAgent; level: number; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || level < 1);
  const hasChildren = agent.children && agent.children.length > 0;
  const meta = DEPT_META[agent.department] || DEPT_META.discovery;
  const statusMeta = STATUS_META[agent.status] || STATUS_META.disabled;
  const { title, subtitle } = splitName(agent.name);
  const initials = getInitials(agent.name);
  const isWorking = agent.status === 'working';

  const toggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen((v) => !v);
  }, []);

  return (
    <div>
      {/* Person card row */}
      <div className={cn(
        'group flex items-center gap-2 rounded-lg transition-all duration-150',
        'hover:bg-slate-50 dark:hover:bg-slate-700/40',
        isWorking && 'bg-cyan-50/40 dark:bg-cyan-950/10',
      )} style={{ paddingLeft: `${level * 28 + 8}px` }}>

        {/* Expand/collapse toggle */}
        <button
          onClick={toggle}
          className={cn(
            'w-5 h-5 flex items-center justify-center rounded shrink-0 transition-colors',
            hasChildren
              ? 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
              : 'text-transparent pointer-events-none',
          )}
        >
          {hasChildren && (open
            ? <ChevronDown className="w-3.5 h-3.5" />
            : <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>

        {/* Avatar with status ring */}
        <div className="relative shrink-0">
          <div className={cn(
            'w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold',
            AVATAR_COLORS[agent.role] || AVATAR_COLORS.specialist,
            isWorking && 'ring-2 ring-offset-1 ring-offset-white dark:ring-offset-slate-800 ring-cyan-400',
          )}>
            {initials}
          </div>
          {/* Status dot */}
          <span className={cn(
            'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-slate-800',
            statusMeta.dot,
            isWorking && 'animate-pulse',
          )} />
        </div>

        {/* Name + subtitle */}
        <Link href={`/agents/${agent.id}`} className="flex-1 min-w-0 py-2">
          <div className="flex items-center gap-2">
            <span className={cn(
              'font-medium truncate',
              agent.role === 'director' ? 'text-[13px] text-slate-900 dark:text-slate-50' :
              agent.role === 'lead' ? 'text-[13px] text-slate-800 dark:text-slate-100' :
              'text-xs text-slate-700 dark:text-slate-200',
            )}>
              {title}
            </span>
            {subtitle && (
              <span className="text-[11px] text-slate-400 dark:text-slate-500 truncate hidden sm:inline">
                {subtitle}
              </span>
            )}
          </div>
          {/* Role + department tags */}
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={cn(
              'text-[9px] font-medium uppercase tracking-wider',
              agent.role === 'director' ? 'text-purple-500' :
              agent.role === 'lead' ? 'text-sky-500' :
              'text-slate-400',
            )}>
              {agent.role}
            </span>
            <span className="text-slate-300 dark:text-slate-600 text-[9px]">in</span>
            <span className={cn('text-[9px] font-medium capitalize', meta.textColor)}>
              {meta.label}
            </span>
          </div>
        </Link>

        {/* Right side: report count + link */}
        <div className="flex items-center gap-2 shrink-0 pr-2">
          {hasChildren && (
            <button
              onClick={toggle}
              className="text-[10px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 tabular-nums"
            >
              {agent.children.length} report{agent.children.length !== 1 ? 's' : ''}
            </button>
          )}
          <Link
            href={`/agents/${agent.id}`}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-primary-500"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* Children — collapsible with animation */}
      {hasChildren && (
        <div className={cn(
          'overflow-hidden transition-all duration-200 ease-in-out',
          open ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0',
        )}>
          {/* Vertical connector line */}
          <div className="relative">
            <div
              className="absolute top-0 bottom-0 w-px bg-slate-200 dark:bg-slate-700"
              style={{ left: `${level * 28 + 20}px` }}
            />
            <div className="space-y-0.5">
              {agent.children.map((child) => (
                <OrgNode
                  key={child.id}
                  agent={child}
                  level={level + 1}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
