'use client';

import { memo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Clock, Play, Pause, Trash2, Plus, CalendarClock,
  Zap, CheckCircle, XCircle, RotateCcw, AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface Routine {
  id: string;
  name: string;
  description?: string;
  cron_expression?: string;
  trigger_type: string;
  concurrency_policy: string;
  enabled: boolean;
  last_run_at?: string;
  next_run_at?: string;
  last_run_status?: string;
  run_count: number;
  task_template: { title?: string; priority?: string; labels?: string[] };
  created_at: string;
}

const CRON_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *', desc: 'At minute 0 of every hour' },
  { label: 'Every day at 9am', cron: '0 9 * * *', desc: 'Daily at 9:00 AM UTC' },
  { label: 'Every weekday at 9am', cron: '0 9 * * 1-5', desc: 'Mon–Fri at 9:00 AM UTC' },
  { label: 'Weekly (Monday)', cron: '0 10 * * 1', desc: 'Every Monday at 10:00 AM UTC' },
  { label: 'Monthly (1st)', cron: '0 9 1 * *', desc: '1st of each month at 9:00 AM UTC' },
];

// ─── Component ──────────────────────────────────────────────────

export const RoutinesView = memo(function RoutinesView() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery<{ routines: Routine[] }>({
    queryKey: ['agent-routines'],
    queryFn: async () => (await apiClient.get('/agent-routines')).data,
    staleTime: 10_000,
  });

  const triggerRoutine = useMutation({
    mutationFn: async (id: string) => (await apiClient.post(`/agent-routines/${id}/trigger`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-routines'] }),
  });

  const deleteRoutine = useMutation({
    mutationFn: async (id: string) => (await apiClient.delete(`/agent-routines/${id}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-routines'] }),
  });

  const routines = data?.routines || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Scheduled Routines</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Automated recurring agent tasks with cron scheduling</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)} className="gap-1.5">
          <Plus className="w-3.5 h-3.5" />
          New Routine
        </Button>
      </div>

      {/* Create form */}
      {showCreate && <CreateRoutineForm onClose={() => setShowCreate(false)} />}

      {/* Routines grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="h-40 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />)}
        </div>
      ) : routines.length === 0 ? (
        <Card className="bg-white dark:bg-slate-800 p-12 text-center">
          <CalendarClock className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
          <p className="text-sm text-slate-500">No routines configured yet</p>
          <p className="text-xs text-slate-400 mt-1">Create a routine to automate recurring agent tasks</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              onTrigger={() => triggerRoutine.mutate(routine.id)}
              onDelete={() => deleteRoutine.mutate(routine.id)}
              isTriggering={triggerRoutine.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// ─── Routine Card ───────────────────────────────────────────────

function RoutineCard({ routine, onTrigger, onDelete, isTriggering }: {
  routine: Routine; onTrigger: () => void; onDelete: () => void; isTriggering: boolean;
}) {
  const lastRunLabel = routine.last_run_status === 'completed' ? 'text-emerald-500' :
    routine.last_run_status === 'failed' ? 'text-red-500' : 'text-slate-400';

  return (
    <div className={cn(
      'rounded-xl border p-5 transition-all duration-300',
      'bg-white dark:bg-slate-800/80',
      routine.enabled
        ? 'border-slate-200 dark:border-slate-700/60 hover:shadow-[0_8px_30px_rgba(6,182,212,0.06)]'
        : 'border-slate-200 dark:border-slate-700/40 opacity-60',
    )}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className={cn(
            'p-2 rounded-lg',
            routine.enabled ? 'bg-cyan-50 dark:bg-cyan-950/30' : 'bg-slate-100 dark:bg-slate-800',
          )}>
            <CalendarClock className={cn('w-4 h-4', routine.enabled ? 'text-cyan-500' : 'text-slate-400')} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{routine.name}</h3>
            {routine.description && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{routine.description}</p>
            )}
          </div>
        </div>
        <Badge className={cn('text-[9px]',
          routine.enabled
            ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-500',
        )}>
          {routine.enabled ? 'active' : 'paused'}
        </Badge>
      </div>

      {/* Schedule info */}
      <div className="space-y-2 mb-4">
        {routine.cron_expression && (
          <div className="flex items-center gap-2 text-xs">
            <Clock className="w-3 h-3 text-slate-400" />
            <span className="font-mono text-slate-600 dark:text-slate-300">{routine.cron_expression}</span>
            <span className="text-slate-400">({describeCron(routine.cron_expression)})</span>
          </div>
        )}
        <div className="flex items-center gap-4 text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <RotateCcw className="w-3 h-3" />
            {routine.run_count} runs
          </span>
          {routine.last_run_at && (
            <span className={cn('flex items-center gap-1', lastRunLabel)}>
              {routine.last_run_status === 'completed' ? <CheckCircle className="w-3 h-3" /> :
                routine.last_run_status === 'failed' ? <XCircle className="w-3 h-3" /> :
                <Clock className="w-3 h-3" />}
              Last: {new Date(routine.last_run_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {routine.next_run_at && routine.enabled && (
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3 text-cyan-400" />
              Next: {new Date(routine.next_run_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </div>

      {/* Task template preview */}
      {routine.task_template?.title && (
        <div className="p-2.5 bg-slate-50 dark:bg-slate-900 rounded-lg mb-4 text-[11px]">
          <span className="text-slate-400">Creates task: </span>
          <span className="text-slate-700 dark:text-slate-300 font-medium">{routine.task_template.title}</span>
          {routine.task_template.priority && (
            <Badge className="ml-1.5 text-[8px] px-1 py-0 bg-slate-200 dark:bg-slate-700 text-slate-500">
              {routine.task_template.priority}
            </Badge>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onTrigger}
          disabled={isTriggering}
          className="gap-1.5 text-xs flex-1"
        >
          <Play className="w-3 h-3" />
          {isTriggering ? 'Triggering...' : 'Run Now'}
        </Button>
        <Button size="sm" variant="outline" onClick={onDelete} className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 px-2">
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Create Routine Form ────────────────────────────────────────

function CreateRoutineForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [taskTitle, setTaskTitle] = useState('');
  const [priority, setPriority] = useState('medium');
  const [concurrency, setConcurrency] = useState('skip_if_active');

  const create = useMutation({
    mutationFn: async () => (await apiClient.post('/agent-routines', {
      name, description, cron_expression: cron, trigger_type: 'schedule',
      task_template: { title: taskTitle || name, priority },
      concurrency_policy: concurrency,
    })).data,
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['agent-routines'] }); onClose(); },
  });

  return (
    <Card className="bg-white dark:bg-slate-800 p-5 border-primary-200 dark:border-primary-800">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-4">Create Routine</h3>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Daily Security Scan"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
        </div>
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Task Title</label>
          <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="Same as routine name"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
        </div>
      </div>

      <div className="mb-4">
        <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description"
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
      </div>

      {/* Schedule presets */}
      <div className="mb-4">
        <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-2 block">Schedule</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {CRON_PRESETS.map(p => (
            <button key={p.cron} onClick={() => setCron(p.cron)}
              className={cn('px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors',
                cron === p.cron
                  ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-700',
              )}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input value={cron} onChange={e => setCron(e.target.value)}
            className="flex-1 px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200" />
          <span className="text-[10px] text-slate-400">{describeCron(cron)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Priority</label>
          <select value={priority} onChange={e => setPriority(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200">
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] font-medium uppercase tracking-wider text-slate-400 mb-1 block">Concurrency</label>
          <select value={concurrency} onChange={e => setConcurrency(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200">
            <option value="skip_if_active">Skip if active</option>
            <option value="coalesce_if_active">Queue one</option>
            <option value="always_enqueue">Always enqueue</option>
          </select>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Creating...' : 'Create Routine'}
        </Button>
      </div>
    </Card>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*') return 'Every minute';
  if (min.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
  if (hour === '*') return `At minute ${min} every hour`;
  if (dow === '1-5') return `Weekdays at ${hour}:${min.padStart(2, '0')} UTC`;
  if (dow === '1') return `Every Monday at ${hour}:${min.padStart(2, '0')} UTC`;
  if (dom === '1' && mon === '*') return `Monthly on 1st at ${hour}:${min.padStart(2, '0')} UTC`;
  if (dow === '*' && dom === '*') return `Daily at ${hour}:${min.padStart(2, '0')} UTC`;
  return cron;
}
