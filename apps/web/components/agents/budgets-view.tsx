'use client';

import { memo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DollarSign, ShieldAlert, CheckCircle, AlertTriangle,
  Plus, TrendingUp, Pause, ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface BudgetPolicy {
  id: string;
  scope_type: string;
  scope_id: string;
  metric: string;
  window: string;
  limit_cents: number;
  warn_percent: string;
  hard_stop: boolean;
  active: boolean;
  created_at: string;
}

interface BudgetIncident {
  id: string;
  policy_id: string;
  agent_id?: string;
  incident_type: string;
  current_spend_cents: number;
  limit_cents: number;
  percent_used: string;
  action_taken?: string;
  resolved: boolean;
  created_at: string;
}

// ─── Component ──────────────────────────────────────────────────

export const BudgetsView = memo(function BudgetsView() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const { data: policiesData } = useQuery<{ policies: BudgetPolicy[] }>({
    queryKey: ['budget-policies'],
    queryFn: async () => (await apiClient.get('/budget-policies')).data,
    staleTime: 15_000,
  });

  const { data: incidentsData } = useQuery<{ incidents: BudgetIncident[] }>({
    queryKey: ['budget-incidents'],
    queryFn: async () => (await apiClient.get('/budget-incidents')).data,
    staleTime: 15_000,
  });

  const resolveIncident = useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/budget-incidents/${id}/resolve`, { resolution_note: 'Resolved manually' })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['budget-incidents'] }),
  });

  const policies = policiesData?.policies || [];
  const incidents = incidentsData?.incidents || [];
  const unresolvedIncidents = incidents.filter(i => !i.resolved);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Budget Management</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Cost limits with automatic hard stops and incident tracking</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)} className="gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          New Policy
        </Button>
      </div>

      {/* Unresolved incidents alert */}
      {unresolvedIncidents.length > 0 && (
        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/40 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="w-5 h-5 text-red-500" />
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">
              {unresolvedIncidents.length} Unresolved Budget Incident{unresolvedIncidents.length > 1 ? 's' : ''}
            </h3>
          </div>
          <div className="space-y-2">
            {unresolvedIncidents.map(incident => (
              <div key={incident.id} className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-lg p-3 border border-red-100 dark:border-red-900/30">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                  <div>
                    <p className="text-xs font-medium text-slate-800 dark:text-slate-200">
                      {incident.incident_type === 'hard_stop' ? 'Hard Stop Triggered' :
                        incident.incident_type === 'warning' ? 'Budget Warning' : incident.incident_type}
                    </p>
                    <p className="text-[10px] text-slate-500">
                      Spent ${(incident.current_spend_cents / 100).toFixed(2)} of ${(incident.limit_cents / 100).toFixed(2)} limit ({parseFloat(incident.percent_used).toFixed(0)}%)
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-slate-400">
                    {new Date(incident.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveIncident.mutate(incident.id)}
                    className="text-xs h-7 gap-1 text-emerald-600 border-emerald-200 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-950/20"
                  >
                    <CheckCircle className="w-3 h-3" />
                    Resolve
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create form */}
      {showCreate && <CreatePolicyForm onClose={() => setShowCreate(false)} />}

      {/* Active policies */}
      {policies.length === 0 ? (
        <Card className="bg-white dark:bg-slate-800 p-12 text-center">
          <DollarSign className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
          <p className="text-sm text-slate-500">No budget policies configured</p>
          <p className="text-xs text-slate-400 mt-1">Create a policy to set spending limits with automatic enforcement</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {policies.map(policy => (
            <PolicyCard key={policy.id} policy={policy} incidents={incidents.filter(i => i.policy_id === policy.id)} />
          ))}
        </div>
      )}

      {/* Resolved incidents history */}
      {incidents.filter(i => i.resolved).length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Incident History</h3>
          <div className="space-y-1.5">
            {incidents.filter(i => i.resolved).slice(0, 10).map(incident => (
              <div key={incident.id} className="flex items-center justify-between py-2 px-3 text-xs bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                <div className="flex items-center gap-2">
                  <CheckCircle className="w-3 h-3 text-emerald-500" />
                  <span className="text-slate-600 dark:text-slate-400">
                    {incident.incident_type} — ${(incident.current_spend_cents / 100).toFixed(2)} / ${(incident.limit_cents / 100).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-slate-400">
                  {incident.action_taken && <span className="text-[10px]">{incident.action_taken}</span>}
                  <span className="text-[10px]">{new Date(incident.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

// ─── Policy Card ────────────────────────────────────────────────

function PolicyCard({ policy, incidents }: { policy: BudgetPolicy; incidents: BudgetIncident[] }) {
  // Simulate current usage (would come from cost tracking in production)
  const latestIncident = incidents[0];
  const currentSpend = latestIncident?.current_spend_cents || 0;
  const usagePct = Math.min(100, (currentSpend / policy.limit_cents) * 100);
  const warnPct = parseFloat(policy.warn_percent) * 100;

  const statusColor = usagePct >= 100 ? 'red' :
    usagePct >= warnPct ? 'amber' : 'emerald';

  const statusLabel = usagePct >= 100 ? (policy.hard_stop ? 'HARD STOP' : 'Over Limit') :
    usagePct >= warnPct ? 'Warning' : 'Healthy';

  return (
    <div className={cn(
      'rounded-xl border p-5 transition-all duration-300',
      'bg-white dark:bg-slate-800/80',
      statusColor === 'red'
        ? 'border-red-200 dark:border-red-800/40 shadow-[0_8px_30px_rgba(239,68,68,0.08)]'
        : statusColor === 'amber'
          ? 'border-amber-200 dark:border-amber-800/40 shadow-[0_8px_30px_rgba(245,158,11,0.06)]'
          : 'border-slate-200 dark:border-slate-700/60',
    )}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={cn('p-2 rounded-lg',
            statusColor === 'red' ? 'bg-red-50 dark:bg-red-950/30' :
              statusColor === 'amber' ? 'bg-amber-50 dark:bg-amber-950/30' :
              'bg-emerald-50 dark:bg-emerald-950/30',
          )}>
            <DollarSign className={cn('w-4 h-4',
              statusColor === 'red' ? 'text-red-500' :
                statusColor === 'amber' ? 'text-amber-500' :
                'text-emerald-500',
            )} />
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 capitalize">
              {policy.scope_type} Budget
            </p>
            <p className="text-[10px] text-slate-400">{policy.window} · {policy.scope_id.slice(0, 8)}...</p>
          </div>
        </div>
        <Badge className={cn('text-[9px]',
          statusColor === 'red' ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400' :
            statusColor === 'amber' ? 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' :
            'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400',
        )}>
          {statusLabel}
        </Badge>
      </div>

      {/* Budget bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
          <span>${(currentSpend / 100).toFixed(2)} spent</span>
          <span>${(policy.limit_cents / 100).toFixed(2)} limit</span>
        </div>
        <div className="h-2.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden relative">
          {/* Warning threshold marker */}
          <div
            className="absolute top-0 bottom-0 w-px bg-amber-400 z-10"
            style={{ left: `${warnPct}%` }}
            title={`Warning at ${warnPct}%`}
          />
          <div
            className={cn('h-full rounded-full transition-all duration-500',
              statusColor === 'red' ? 'bg-red-500' :
                statusColor === 'amber' ? 'bg-amber-400' :
                'bg-emerald-400',
            )}
            style={{ width: `${Math.min(100, usagePct)}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1 text-[9px] text-slate-400">
          <span>{usagePct.toFixed(0)}% used</span>
          <span>Warn at {warnPct}%</span>
        </div>
      </div>

      {/* Policy details */}
      <div className="flex items-center gap-3 text-[10px] text-slate-400">
        {policy.hard_stop && (
          <span className="flex items-center gap-1 text-red-400">
            <Pause className="w-3 h-3" />
            Hard stop enabled
          </span>
        )}
        <span className="capitalize">{policy.window}</span>
        {incidents.length > 0 && (
          <span className="flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {incidents.length} incident{incidents.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Create Policy Form ─────────────────────────────────────────

function CreatePolicyForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [scopeType, setScopeType] = useState('project');
  const [scopeId, setScopeId] = useState('');
  const [limitDollars, setLimitDollars] = useState('25');
  const [window, setWindow] = useState('monthly');
  const [warnPct, setWarnPct] = useState('80');
  const [hardStop, setHardStop] = useState(true);

  const create = useMutation({
    mutationFn: async () => (await apiClient.post('/budget-policies', {
      scope_type: scopeType,
      scope_id: scopeId,
      limit_cents: Math.round(parseFloat(limitDollars) * 100),
      window,
      warn_percent: parseFloat(warnPct) / 100,
      hard_stop: hardStop,
    })).data,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['budget-policies'] }); onClose(); },
  });

  return (
    <Card className="bg-white dark:bg-slate-800 p-5 border-primary-200 dark:border-primary-800">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">Create Budget Policy</h3>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Scope</label>
          <select value={scopeType} onChange={e => setScopeType(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200">
            <option value="organization">Organization</option>
            <option value="project">Project</option>
            <option value="agent">Agent</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Scope ID</label>
          <input value={scopeId} onChange={e => setScopeId(e.target.value)} placeholder="UUID"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-mono" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Limit ($)</label>
          <input type="number" value={limitDollars} onChange={e => setLimitDollars(e.target.value)} min="1"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
        </div>
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Window</label>
          <select value={window} onChange={e => setWindow(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="lifetime">Lifetime</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Warn at %</label>
          <input type="number" value={warnPct} onChange={e => setWarnPct(e.target.value)} min="50" max="99"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
        </div>
      </div>

      <label className="flex items-center gap-2 mb-4 cursor-pointer">
        <input type="checkbox" checked={hardStop} onChange={e => setHardStop(e.target.checked)}
          className="rounded border-slate-300 dark:border-slate-600" />
        <span className="text-xs text-slate-700 dark:text-slate-300">Enable hard stop (pause execution when limit reached)</span>
      </label>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!scopeId.trim() || create.isPending}>
          {create.isPending ? 'Creating...' : 'Create Policy'}
        </Button>
      </div>
    </Card>
  );
}
