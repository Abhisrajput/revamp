'use client';

import { useState } from 'react';
import { useAgents, useAgentDashboard } from '@/lib/hooks/use-agents';
import { useOrchestrator } from '@/lib/hooks/use-orchestrator';
import { AgentCard } from '@/components/agents/agent-card';
import { DepartmentCards } from '@/components/agents/department-cards';
import { ControlsBar } from '@/components/agents/orchestrator/controls-bar';
import { StatsBar } from '@/components/agents/orchestrator/stats-bar';
import { OrchestratorCore } from '@/components/agents/orchestrator/orchestrator-core';
import { TaskQueue } from '@/components/agents/orchestrator/task-queue';
import { ExecutionLog } from '@/components/agents/orchestrator/execution-log';
import { AgentGrid } from '@/components/agents/orchestrator/agent-grid';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Brain, Hammer, Shield, FileText, Users,
  DollarSign, Activity, AlertTriangle,
  LayoutGrid, List, Network,
} from 'lucide-react';

const ROLES = ['all', 'director', 'lead', 'specialist'] as const;
const STATUSES = ['all', 'idle', 'working', 'paused', 'disabled'] as const;

const DEPT_ICONS: Record<string, typeof Brain> = {
  discovery: Brain,
  execution: Hammer,
  qa: Shield,
  pm: FileText,
};

type ViewMode = 'list' | 'department' | 'orchestrator';

export default function AgentsPage() {
  const [department, setDepartment] = useState<string>('all');
  const [role, setRole] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');

  const { data: agents, isLoading } = useAgents({
    department: department !== 'all' ? department : undefined,
    role: role !== 'all' ? role : undefined,
    status: status !== 'all' ? status : undefined,
  });

  const { data: allAgents } = useAgents();
  const { data: dashboard } = useAgentDashboard();

  const orchestrator = useOrchestrator();

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-50">
            Agent Department
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Manage AI agent personas, budgets, and assignments
          </p>
        </div>

        {/* View Mode Toggle */}
        <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
          <ViewToggle mode="list" icon={List} label="List" active={viewMode} onSelect={setViewMode} />
          <ViewToggle mode="department" icon={LayoutGrid} label="Departments" active={viewMode} onSelect={setViewMode} />
          <ViewToggle mode="orchestrator" icon={Network} label="Orchestrator" active={viewMode} onSelect={setViewMode} />
        </div>
      </div>

      {/* ═══ ORCHESTRATOR VIEW ═══ */}
      {viewMode === 'orchestrator' ? (
        <OrchestratorView orchestrator={orchestrator} />
      ) : (
        <>
          {/* Dashboard Summary */}
          {dashboard && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              <Card className="bg-white dark:bg-slate-800 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-4 h-4 text-slate-400" />
                  <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Total Agents</p>
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-slate-50">
                  {dashboard.totalAgents}
                </p>
              </Card>
              <Card className="bg-white dark:bg-slate-800 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="w-4 h-4 text-slate-400" />
                  <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Active Tasks</p>
                </div>
                <p className="text-2xl font-bold text-primary-600 dark:text-primary-400">
                  {dashboard.activeAssignments}
                </p>
              </Card>
              <Card className="bg-white dark:bg-slate-800 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <DollarSign className="w-4 h-4 text-slate-400" />
                  <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Monthly Spend</p>
                </div>
                <p className="text-2xl font-bold text-slate-900 dark:text-slate-50">
                  ${(dashboard.totalSpentCents / 100).toFixed(2)}
                </p>
              </Card>
              <Card className="bg-white dark:bg-slate-800 p-4">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle className="w-4 h-4 text-slate-400" />
                  <p className="text-xs text-slate-500 dark:text-slate-400 uppercase">Paused</p>
                </div>
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
                  {dashboard.byStatus.paused || 0}
                </p>
              </Card>
            </div>
          )}

          {/* ═══ DEPARTMENT VIEW ═══ */}
          {viewMode === 'department' && dashboard && allAgents ? (
            <DepartmentCards dashboard={dashboard} agents={allAgents} />
          ) : viewMode === 'list' ? (
            <>
              {/* ═══ LIST VIEW ═══ */}
              {/* Department Breakdown */}
              {dashboard && (
                <div className="grid grid-cols-4 gap-3 mb-6">
                  {Object.entries(dashboard.byDepartment).map(([dept, count]) => {
                    const Icon = DEPT_ICONS[dept] || Brain;
                    return (
                      <button
                        key={dept}
                        onClick={() => setDepartment(department === dept ? 'all' : dept)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                          department === dept
                            ? 'border-primary-300 dark:border-primary-700 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                        <span className="capitalize font-medium">{dept}</span>
                        <Badge className="ml-auto bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-xs">
                          {count}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Filters */}
              <div className="flex gap-2 mb-6">
                <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
                  {ROLES.map((r) => (
                    <button
                      key={r}
                      onClick={() => setRole(r)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                        role === r
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-50 shadow-sm'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatus(s)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                        status === s
                          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-50 shadow-sm'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Agent Grid */}
              {isLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Card key={i} className="bg-white dark:bg-slate-800 p-4 animate-pulse">
                      <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded w-3/4 mb-3" />
                      <div className="h-3 bg-slate-200 dark:bg-slate-700 rounded w-1/2 mb-3" />
                      <div className="h-2 bg-slate-200 dark:bg-slate-700 rounded w-full" />
                    </Card>
                  ))}
                </div>
              ) : agents && agents.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[...agents]
                    .sort((a, b) => {
                      const order: Record<string, number> = { working: 0, idle: 1, paused: 2, disabled: 3 };
                      return (order[a.status] ?? 4) - (order[b.status] ?? 4);
                    })
                    .map((agent) => (
                      <AgentCard key={agent.id} agent={agent} />
                    ))}
                </div>
              ) : (
                <Card className="bg-white dark:bg-slate-800 p-12 text-center">
                  <Users className="w-12 h-12 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-1">
                    No agents found
                  </h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {department !== 'all' || role !== 'all' || status !== 'all'
                      ? 'Try adjusting your filters.'
                      : 'Run the seed script to create default agent personas.'}
                  </p>
                </Card>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

// ─── VIEW TOGGLE BUTTON ─────────────────────────────────────────

function ViewToggle({
  mode,
  icon: Icon,
  label,
  active,
  onSelect,
}: {
  mode: ViewMode;
  icon: typeof List;
  label: string;
  active: ViewMode;
  onSelect: (m: ViewMode) => void;
}) {
  return (
    <button
      onClick={() => onSelect(mode)}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
        active === mode
          ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-50 shadow-sm'
          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

// ─── ORCHESTRATOR VIEW ──────────────────────────────────────────

function OrchestratorView({
  orchestrator,
}: {
  orchestrator: ReturnType<typeof useOrchestrator>;
}) {
  const {
    state,
    stats,
    agentStates,
    executionLog,
    taskQueue,
    connected,
    period,
    setPeriod,
    start,
    pause,
    reset,
  } = orchestrator;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <Card className="bg-white dark:bg-slate-800/80 p-4 border-slate-200 dark:border-slate-700/50">
        <ControlsBar
          state={state}
          connected={connected}
          onStart={start}
          onPause={pause}
          onReset={reset}
        />
      </Card>

      {/* Stats + Period Selector */}
      <StatsBar stats={stats} period={period} onPeriodChange={setPeriod} />

      {/* 3-column: Task Queue | Core | Log */}
      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_360px] gap-4">
        {/* Task Queue */}
        <Card className="bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700/50">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Task Queue
              </h2>
              <span className="text-[10px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">
                {taskQueue.length}
              </span>
            </div>
          </div>
          <div className="p-3 max-h-[540px] overflow-y-auto scrollbar-thin">
            <TaskQueue tasks={taskQueue} />
          </div>
        </Card>

        {/* Orchestrator Core */}
        <Card className="bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700/50">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Orchestrator Core
              </h2>
              <div className="flex items-center gap-3 text-[10px] text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-purple-500" />
                  Discovery
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  Execution
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  QA
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  PM
                </span>
              </div>
            </div>
          </div>
          <div className="p-6 flex items-center justify-center min-h-[480px]">
            <OrchestratorCore agents={agentStates} orchestratorState={state} />
          </div>
        </Card>

        {/* Execution Log — wider column for detailed entries */}
        <Card className="bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700/50">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Activity Log
              </h2>
              <span className="text-[10px] font-mono text-slate-400 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">
                {executionLog.length} events
              </span>
            </div>
          </div>
          <div className="p-2 max-h-[540px] overflow-y-auto scrollbar-thin">
            <ExecutionLog entries={executionLog} />
          </div>
        </Card>
      </div>

      {/* Agent Grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Agent Department
          </h2>
          <span className="text-[10px] text-slate-400">
            {agentStates.filter((a) => a.status === 'working').length} working / {agentStates.length} total
          </span>
        </div>
        <AgentGrid agents={agentStates} />
      </div>
    </div>
  );
}
