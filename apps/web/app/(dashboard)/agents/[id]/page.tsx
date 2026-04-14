'use client';

import { use, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAgent, useAgentCosts, useUpdateAgent, useDeleteAgent } from '@revamp/core';
import { useAuthStore } from '@/lib/stores/auth-store';
import { BudgetBar } from '@/components/agents/budget-bar';
import { StatusIndicator } from '@/components/agents/status-indicator';
import { ReportingChain, Subordinates } from '@/components/agents/reporting-chain';
import { RecentSessions } from '@/components/agents/recent-sessions';
import { EvolutionMemoryPanel } from '@/components/agents/evolution-memory';
import { CostHistoryChart } from '@/components/agents/cost-history-chart';
import { Card } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { Button } from '@revamp/ui/components/button';
import { Input } from '@revamp/ui/components/input';
import {
  ArrowLeft, Brain, Shield, Hammer, FileText,
  Pause, Play, Trash2, DollarSign, Clock,
  Cpu, GitBranch, Wrench, Layers, Pencil, Check, X, Plus,
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

// ─── Inline editable field ──────────────────────────────────────────
function EditableField({
  label,
  value,
  onSave,
  type = 'text',
  isAdmin,
}: {
  label: string;
  value: string | number;
  onSave: (v: string) => void;
  type?: string;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  const commit = () => { onSave(draft); setEditing(false); };
  const cancel = () => { setDraft(String(value)); setEditing(false); };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-7 text-sm py-0 px-2 w-full"
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
        />
        <button onClick={commit} className="text-emerald-600 hover:text-emerald-700"><Check className="w-3.5 h-3.5" /></button>
        <button onClick={cancel} className="text-slate-400 hover:text-slate-600"><X className="w-3.5 h-3.5" /></button>
      </div>
    );
  }

  return (
    <div className="flex justify-between items-center">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="flex items-center gap-1.5 font-medium text-slate-900 dark:text-slate-100 capitalize">
        <span className={type === 'text' && label.toLowerCase().includes('model') ? 'font-mono text-xs' : ''}>
          {value === '' || value === null || value === undefined ? <span className="text-slate-400">—</span> : String(value)}
        </span>
        {isAdmin && (
          <button onClick={() => { setDraft(String(value)); setEditing(true); }} className="opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-primary-600">
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </dd>
    </div>
  );
}

// ─── Editable tag list ──────────────────────────────────────────────
function EditableTagList({
  items,
  onSave,
  isAdmin,
  colorClass = 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300',
}: {
  items: string[];
  onSave: (items: string[]) => void;
  isAdmin: boolean;
  colorClass?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(items);
  const [newItem, setNewItem] = useState('');

  const addItem = () => {
    const trimmed = newItem.trim();
    if (trimmed && !draft.includes(trimmed)) {
      setDraft([...draft, trimmed]);
    }
    setNewItem('');
  };

  const removeItem = (item: string) => setDraft(draft.filter((i) => i !== item));

  const commit = () => { onSave(draft); setEditing(false); };
  const cancel = () => { setDraft(items); setEditing(false); setNewItem(''); };

  if (!editing) {
    return (
      <div className="flex flex-wrap gap-1.5 items-center">
        {items.map((item) => (
          <Badge key={item} className={`${colorClass} text-xs`}>{item}</Badge>
        ))}
        {isAdmin && (
          <button onClick={() => { setDraft([...items]); setEditing(true); }} className="text-xs text-slate-400 hover:text-primary-600 flex items-center gap-0.5 ml-1">
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {draft.map((item) => (
          <span key={item} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${colorClass}`}>
            {item}
            <button onClick={() => removeItem(item)} className="text-current opacity-60 hover:opacity-100"><X className="w-2.5 h-2.5" /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-1">
        <Input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          placeholder="Add item…"
          className="h-7 text-xs py-0 px-2"
          onKeyDown={(e) => { if (e.key === 'Enter') addItem(); if (e.key === 'Escape') cancel(); }}
        />
        <button onClick={addItem} className="text-emerald-600 hover:text-emerald-700"><Plus className="w-4 h-4" /></button>
      </div>
      <div className="flex gap-1.5">
        <button onClick={commit} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium flex items-center gap-1"><Check className="w-3 h-3" />Save</button>
        <button onClick={cancel} className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"><X className="w-3 h-3" />Cancel</button>
      </div>
    </div>
  );
}

// ─── Editable textarea ──────────────────────────────────────────────
function EditableTextarea({
  value,
  onSave,
  isAdmin,
}: {
  value: string;
  onSave: (v: string) => void;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => { onSave(draft); setEditing(false); };
  const cancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <div className="relative group">
        <p className="text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap leading-relaxed">
          {value}
        </p>
        {isAdmin && (
          <button
            onClick={() => { setDraft(value); setEditing(true); }}
            className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400 hover:text-primary-600"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full min-h-[120px] text-xs text-slate-900 dark:text-slate-100 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-primary-500 leading-relaxed resize-y"
        autoFocus
      />
      <div className="flex gap-2">
        <button onClick={commit} className="text-xs text-emerald-600 hover:text-emerald-700 font-medium flex items-center gap-1"><Check className="w-3 h-3" />Save</button>
        <button onClick={cancel} className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"><X className="w-3 h-3" />Cancel</button>
      </div>
    </div>
  );
}

// ─── Toggle switch ──────────────────────────────────────────────────
function ToggleSwitch({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-primary-600' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

// ─── Main page ──────────────────────────────────────────────────────
export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: agent, isLoading, refetch } = useAgent(id) as any;
  const { data: costs } = useAgentCosts(id, 200);
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const save = useCallback(async (updates: Record<string, unknown>) => {
    await updateAgent.mutate(id, updates as any);
    refetch?.();
  }, [id, updateAgent, refetch]);

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
          <ArrowLeft className="w-4 h-4 mr-2" />Back to Agents
        </Button>
      </div>
    );
  }

  const dept = DEPT_META[agent.department] || DEPT_META.discovery;
  const DeptIcon = dept.icon;
  const isPaused = agent.status === 'paused';
  const isDisabled = agent.status === 'disabled';

  const handleTogglePause = () => {
    save(isPaused
      ? { status: 'idle', pause_reason: null }
      : { status: 'paused', pause_reason: 'Manually paused by admin' });
  };

  const handleDelete = async () => {
    await deleteAgent.mutate(agent.id);
    router.push('/agents');
  };

  // helpers to parse JSON arrays from API (may come back as string or array)
  const toArr = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  };

  const skills = Array.isArray(agent.skills)
    ? agent.skills
    : (typeof agent.skills === 'string' ? JSON.parse(agent.skills || '[]') : []);
  const toolPerms = toArr(agent.tool_permissions);
  const stagePerms = toArr(agent.stage_permissions);
  const techStack = toArr(agent.tech_stack);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={() => router.push('/agents')}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className={`relative w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-700 flex items-center justify-center ${dept.color}`}>
          <DeptIcon className="w-5 h-5" />
          <StatusIndicator status={agent.status} size="md" className="absolute -top-1 -right-1" />
        </div>
        <div className="flex-1 group">
          {isAdmin ? (
            <EditableField
              label=""
              value={agent.name}
              onSave={(v) => save({ name: v })}
              isAdmin={isAdmin}
            />
          ) : (
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">{agent.name}</h1>
          )}
          <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
            {agent.slug} &middot; v{agent.version ?? 1}
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
          {isAdmin && (
            showConfirmDelete ? (
              <div className="flex gap-1">
                <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleteAgent.isPending}>Confirm</Button>
                <Button variant="outline" size="sm" onClick={() => setShowConfirmDelete(false)}>Cancel</Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setShowConfirmDelete(true)}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )
          )}
        </div>
      </div>

      {isAdmin && (
        <p className="text-xs text-primary-600 dark:text-primary-400 mb-4 flex items-center gap-1">
          <Pencil className="w-3 h-3" />
          Hover over any field to edit it inline.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column */}
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
              <div className="group">
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Monthly Limit</p>
                <EditableField
                  label=""
                  value={(agent.monthly_budget_cents / 100).toFixed(2)}
                  onSave={(v) => save({ monthly_budget_cents: Math.round(parseFloat(v) * 100) })}
                  type="number"
                  isAdmin={isAdmin}
                />
              </div>
              <div className="group">
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Warning At</p>
                <EditableField
                  label=""
                  value={(parseFloat(agent.warning_threshold) * 100).toFixed(0) + '%'}
                  onSave={(v) => save({ warning_threshold: (parseFloat(v.replace('%', '')) / 100).toFixed(2) })}
                  isAdmin={isAdmin}
                />
              </div>
              <div className="group">
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Hard Stop</p>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                    {agent.hard_stop_enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  {isAdmin && (
                    <ToggleSwitch
                      checked={agent.hard_stop_enabled}
                      onChange={() => save({ hard_stop_enabled: !agent.hard_stop_enabled })}
                    />
                  )}
                </div>
              </div>
            </div>
          </Card>

          {/* Cost History */}
          {costs && costs.length > 0 && <CostHistoryChart costs={costs} />}

          {/* Skills */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Layers className="w-4 h-4 text-slate-400" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Skills</h2>
              <Badge className="ml-auto bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                {skills.length}
              </Badge>
            </div>
            {isAdmin ? (
              <EditableTagList
                items={skills.map((s: any) => typeof s === 'string' ? s : s.name)}
                onSave={(items) => save({ skills: items.map((name) => ({ name, proficiency: 'intermediate' })) })}
                isAdmin={isAdmin}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {skills.map((skill: any) => (
                  <div key={skill.name} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                    <span className="text-sm text-slate-900 dark:text-slate-100">{skill.name}</span>
                    {skill.proficiency && (
                      <Badge className={`text-[10px] ${PROFICIENCY_COLORS[skill.proficiency] || PROFICIENCY_COLORS.intermediate}`}>
                        {skill.proficiency}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
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
                <EditableTagList
                  items={toolPerms}
                  onSave={(items) => save({ tool_permissions: items })}
                  isAdmin={isAdmin}
                  colorClass="bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
                />
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase mb-2">Stages</p>
                <EditableTagList
                  items={stagePerms}
                  onSave={(items) => save({ stage_permissions: items })}
                  isAdmin={isAdmin}
                  colorClass="bg-primary-100 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400"
                />
              </div>
            </div>
          </Card>

          <RecentSessions agentId={id} />
          <EvolutionMemoryPanel agentId={id} />

          {/* Recent Costs */}
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
                    {costs.slice(0, 20).map((c: any) => (
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
                        <td className="py-2 text-xs text-slate-400">{new Date(c.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        {/* Right Column */}
        <div className="space-y-6">

          {/* Configuration */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">Configuration</h3>
            <dl className="space-y-3 text-sm">
              {[
                { label: 'Role', field: 'role', value: agent.role },
                { label: 'Department', field: 'department', value: agent.department },
                { label: 'Provider', field: 'preferred_provider', value: agent.preferred_provider || '' },
                { label: 'Model', field: 'preferred_model', value: agent.preferred_model || '' },
                { label: 'Max Tasks', field: 'max_concurrent_tasks', value: agent.max_concurrent_tasks, type: 'number' as const },
                { label: 'Memory', field: 'memory_strategy', value: agent.memory_strategy || 'summary' },
              ].map(({ label, field, value, type }) => (
                <div key={field} className="group">
                  <EditableField
                    label={label}
                    value={value}
                    onSave={(v) => save({ [field]: type === 'number' ? parseInt(v, 10) : v })}
                    type={type ?? 'text'}
                    isAdmin={isAdmin}
                  />
                </div>
              ))}
              <div className="flex justify-between items-center">
                <dt className="text-slate-500 dark:text-slate-400">Can Delegate</dt>
                <dd className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                  {agent.can_delegate ? 'Yes' : 'No'}
                  {isAdmin && (
                    <ToggleSwitch
                      checked={agent.can_delegate}
                      onChange={() => save({ can_delegate: !agent.can_delegate })}
                    />
                  )}
                </dd>
              </div>
            </dl>
          </Card>

          {/* Tech Stack */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-3">
              <Cpu className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Tech Stack</h3>
            </div>
            <EditableTagList
              items={techStack}
              onSave={(items) => save({ tech_stack: items })}
              isAdmin={isAdmin}
            />
          </Card>

          {/* Hierarchy */}
          <ReportingChain agentId={id} agentName={agent.name} />
          <Subordinates agentId={id} />

          <Card className="bg-white dark:bg-slate-800 p-6">
            <div className="flex items-center gap-2 mb-3">
              <GitBranch className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Hierarchy</h3>
            </div>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-slate-500 dark:text-slate-400 text-xs mb-1">Reports To</dt>
                <dd>
                  {agent.reportsToAgent ? (
                    <a href={`/agents/${agent.reportsToAgent.id}`} className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                      <span className="w-6 h-6 rounded-full bg-sky-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                        {agent.reportsToAgent.name?.split(/[\s—]/)[0]?.slice(0, 2).toUpperCase() || '??'}
                      </span>
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{agent.reportsToAgent.name}</span>
                      <span className="text-[10px] text-slate-400 capitalize">{agent.reportsToAgent.role}</span>
                    </a>
                  ) : (
                    <span className="text-slate-400 text-xs">None (top-level)</span>
                  )}
                </dd>
              </div>
              {agent.subordinates && agent.subordinates.length > 0 && (
                <div>
                  <dt className="text-slate-500 dark:text-slate-400 text-xs mb-1.5">
                    Subordinates ({agent.subordinates.length})
                  </dt>
                  <div className="space-y-1">
                    {agent.subordinates.map((sub: any) => (
                      <dd key={sub.id}>
                        <a href={`/agents/${sub.id}`} className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                          <span className={`w-5 h-5 rounded-full text-white text-[9px] font-bold flex items-center justify-center shrink-0 ${sub.role === 'lead' ? 'bg-sky-600' : 'bg-slate-500'}`}>
                            {sub.name?.split(/[\s—]/)[0]?.slice(0, 2).toUpperCase() || '??'}
                          </span>
                          <span className="text-xs font-medium text-slate-900 dark:text-slate-100">{sub.name}</span>
                          <span className="text-[10px] text-slate-400 capitalize">{sub.role}</span>
                        </a>
                      </dd>
                    ))}
                  </div>
                </div>
              )}
            </dl>
          </Card>

          {/* System Prompt */}
          <Card className="bg-white dark:bg-slate-800 p-6">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">System Prompt</h3>
            <EditableTextarea
              value={agent.system_prompt || ''}
              onSave={(v) => save({ system_prompt: v })}
              isAdmin={isAdmin}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
