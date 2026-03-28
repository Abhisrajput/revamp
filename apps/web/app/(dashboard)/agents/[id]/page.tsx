'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAgent, useAgentCosts, useUpdateAgent, useDeleteAgent } from '@/lib/hooks/use-agents';
import { BudgetBar } from '@/components/agents/budget-bar';
import { StatusIndicator } from '@/components/agents/status-indicator';
import { ReportingChain, Subordinates } from '@/components/agents/reporting-chain';
import { RecentSessions } from '@/components/agents/recent-sessions';
import { EvolutionMemoryPanel } from '@/components/agents/evolution-memory';
import { CostHistoryChart } from '@/components/agents/cost-history-chart';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Brain, Shield, Hammer, FileText,
  Pause, Play, Trash2, DollarSign, Clock,
  Cpu, GitBranch, Wrench, Layers,
} from 'lucide-react';

const DEPT_META: Record<string, { icon: typeof Brain; color: string }> = {
  discovery: { icon: Brain, color: 'text-purple-500' },
  execution: { icon: Hammer, color: 'text-blue-500' },
  qa: { icon: Shield, color: 'text-emerald-500' },
  pm: { icon: FileText, color: 'text-amber-500' },
};

const STATUS_COLORS: Record<string, string> = {
  idle: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
  working: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  paused: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  disabled: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
};

const PROFICIENCY_COLORS: Record<string, string> = {
  expert: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
  advanced: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
  intermediate: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
};

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: agent, isLoading } = useAgent(id);
  const { data: costs } = useAgentCosts(id, 200);
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-slate-200 dark:bg-slate-700 rounded w-1/3" />
        <div className="h-64 bg-slate-200 dark:bg-slate-700 rounded" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="text-center py-16">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Agent not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/agents')}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Agents
        </Button>
      </div>
    );
  }

  const dept = DEPT_META[agent.department] || DEPT_META.discovery;
  const DeptIcon = dept.icon;
  const isPaused = agent.status === 'paused';
  const isDisabled = agent.status === 'disabled';

  const handleTogglePause = () => {
    updateAgent.mutate({
      id: agent.id,
      data: isPaused
        ? { status: 'idle', pause_reason: null }
        : { status: 'paused', pause_reason: 'Manually paused by admin' },
    });
  };

  const handleDelete = () => {
    deleteAgent.mutate(agent.id, {
      onSuccess: () => router.push('/agents'),
    });
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={() => router.push('/agents')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className={`relative w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center ${dept.color}`}>
          <DeptIcon className="w-5 h-5" />
          <StatusIndicator
            status={agent.status}
            size="md"
            className="absolute -top-1 -right-1"
          />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
            {agent.name}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
            {agent.slug} &middot; v{agent.version}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={STATUS_COLORS[agent.status]}>{agent.status}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTogglePause}
            disabled={isDisabled || updateAgent.isPending}
          >
            {isPaused ? <Play className="w-4 h-4 mr-1" /> : <Pause className="w-4 h-4 mr-1" />}
            {isPaused ? 'Resume' : 'Pause'}
          </Button>
          {showConfirmDelete ? (
            <div className="flex gap-1">
              <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteAgent.isPending}>
                Confirm
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowConfirmDelete(true)}>
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column — Details */}
        <div className="lg:col-span-2 space-y-6">
          {/* Budget */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-4">
              <DollarSign className="w-4 h-4 text-slate-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Budget</h2>
            </div>
            <BudgetBar
              spentCents={agent.spent_monthly_cents}
              limitCents={agent.monthly_budget_cents}
              warningThreshold={parseFloat(agent.warning_threshold)}
              hardStop={agent.hard_stop_enabled}
            />
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400">Monthly Limit</p>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  ${(agent.monthly_budget_cents / 100).toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400">Warning At</p>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {(parseFloat(agent.warning_threshold) * 100).toFixed(0)}%
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400">Hard Stop</p>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {agent.hard_stop_enabled ? 'Enabled' : 'Disabled'}
                </p>
              </div>
            </div>
          </Card>

          {/* Cost History Chart */}
          {costs && costs.length > 0 && (
            <CostHistoryChart costs={costs} />
          )}

          {/* Skills */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Layers className="w-4 h-4 text-slate-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Skills</h2>
              <Badge className="ml-auto bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                {agent.skills.length}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {agent.skills.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 dark:bg-slate-700/50 rounded-lg"
                >
                  <span className="text-sm text-slate-900 dark:text-slate-100">{skill.name}</span>
                  <Badge className={`text-[10px] ${PROFICIENCY_COLORS[skill.proficiency] || PROFICIENCY_COLORS.intermediate}`}>
                    {skill.proficiency}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>

          {/* Permissions */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Wrench className="w-4 h-4 text-slate-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Permissions</h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase mb-2">Tools</p>
                <div className="flex flex-wrap gap-1.5">
                  {agent.tool_permissions.map((perm) => (
                    <Badge key={perm} className="bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-mono text-xs">
                      {perm}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase mb-2">Stages</p>
                <div className="flex flex-wrap gap-1.5">
                  {agent.stage_permissions.map((stage) => (
                    <Badge key={stage} className="bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400 text-xs">
                      {stage}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          {/* Recent Sessions */}
          <RecentSessions agentId={id} />

          {/* Evolution Memory (OpenViking) */}
          <EvolutionMemoryPanel agentId={id} />

          {/* Recent Costs Table */}
          {costs && costs.length > 0 && (
            <Card className="bg-white dark:bg-slate-800 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Clock className="w-4 h-4 text-slate-400" />
                <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Recent Cost Events</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-2 text-slate-600 dark:text-slate-400">Provider</th>
                      <th className="text-left py-2 text-slate-600 dark:text-slate-400">Model</th>
                      <th className="text-right py-2 text-slate-600 dark:text-slate-400">Tokens</th>
                      <th className="text-right py-2 text-slate-600 dark:text-slate-400">Cost</th>
                      <th className="text-left py-2 text-slate-600 dark:text-slate-400">Stage</th>
                      <th className="text-left py-2 text-slate-600 dark:text-slate-400">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costs.slice(0, 20).map((c) => (
                      <tr key={c.id} className="border-b border-slate-100 dark:border-slate-700/50">
                        <td className="py-2 font-mono text-slate-900 dark:text-slate-100">{c.provider}</td>
                        <td className="py-2 font-mono text-slate-600 dark:text-slate-400 text-xs">{c.model}</td>
                        <td className="py-2 text-right text-slate-600 dark:text-slate-400">
                          {(c.input_tokens + c.output_tokens).toLocaleString()}
                        </td>
                        <td className="py-2 text-right font-medium text-slate-900 dark:text-slate-100">
                          ${(c.cost_cents / 100).toFixed(4)}
                        </td>
                        <td className="py-2 text-slate-500 dark:text-slate-400">{c.stage_name || '-'}</td>
                        <td className="py-2 text-xs text-slate-400">
                          {new Date(c.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        {/* Right Column — Sidebar Info */}
        <div className="space-y-6">
          {/* Configuration */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">Configuration</h3>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Role</dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100 capitalize">{agent.role}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Department</dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100 capitalize">{agent.department}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Provider</dt>
                <dd className="font-mono text-slate-900 dark:text-slate-100 text-xs">{agent.preferred_provider || '-'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Model</dt>
                <dd className="font-mono text-slate-900 dark:text-slate-100 text-xs">{agent.preferred_model || '-'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Max Tasks</dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100">{agent.max_concurrent_tasks}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Can Delegate</dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100">{agent.can_delegate ? 'Yes' : 'No'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500 dark:text-slate-400">Memory</dt>
                <dd className="font-medium text-slate-900 dark:text-slate-100 capitalize">{agent.memory_strategy}</dd>
              </div>
            </dl>
          </Card>

          {/* Tech Stack */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-3">
              <Cpu className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Tech Stack</h3>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {agent.tech_stack.map((tech) => (
                <Badge key={tech} className="bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs">
                  {tech}
                </Badge>
              ))}
            </div>
          </Card>

          {/* Reporting Chain */}
          <ReportingChain agentId={id} agentName={agent.name} />

          {/* Subordinates */}
          <Subordinates agentId={id} />

          {/* Hierarchy (legacy — kept for fallback) */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-3">
              <GitBranch className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Hierarchy</h3>
            </div>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-slate-500 dark:text-slate-400 text-xs">Reports To</dt>
                <dd className="font-mono text-slate-900 dark:text-slate-100">
                  {agent.reports_to ? agent.reports_to.slice(0, 8) + '...' : 'None (top-level)'}
                </dd>
              </div>
              {agent.subordinates && agent.subordinates.length > 0 && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400 text-xs mb-1">
                    Subordinates ({agent.subordinates.length})
                  </dt>
                  <div className="space-y-1">
                    {agent.subordinates.map((sub) => (
                      <dd key={sub.id} className="text-slate-900 dark:text-slate-100 text-xs">
                        {sub.name} <span className="text-slate-400">({sub.slug})</span>
                      </dd>
                    ))}
                  </div>
                </div>
              )}
            </dl>
          </Card>

          {/* System Prompt Preview */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">System Prompt</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-6 whitespace-pre-wrap leading-relaxed">
              {agent.system_prompt}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
