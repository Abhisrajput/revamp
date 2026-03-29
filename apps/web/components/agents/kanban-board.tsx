'use client';

import { memo, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle, Clock, Plus, GripVertical,
  ArrowUp, ArrowDown, Minus, Loader2, Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface AgentTask {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assigned_agent_id?: string;
  labels: string[];
  progress: number;
  tokens_used: number;
  cost_cents: number;
  created_at: string;
}

type KanbanStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';

const COLUMNS: { id: KanbanStatus; label: string; color: string; icon: React.ElementType }[] = [
  { id: 'backlog', label: 'Backlog', color: 'text-slate-400', icon: Clock },
  { id: 'todo', label: 'Todo', color: 'text-blue-500', icon: Clock },
  { id: 'in_progress', label: 'In Progress', color: 'text-cyan-500', icon: Loader2 },
  { id: 'in_review', label: 'In Review', color: 'text-amber-500', icon: CheckCircle },
  { id: 'blocked', label: 'Blocked', color: 'text-red-500', icon: AlertTriangle },
  { id: 'done', label: 'Done', color: 'text-emerald-500', icon: CheckCircle },
];

const PRIORITY_CONFIG: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  critical: { icon: ArrowUp, color: 'text-red-500', label: 'Critical' },
  high: { icon: ArrowUp, color: 'text-orange-500', label: 'High' },
  medium: { icon: Minus, color: 'text-slate-400', label: 'Medium' },
  low: { icon: ArrowDown, color: 'text-blue-400', label: 'Low' },
};

// ─── Component ──────────────────────────────────────────────────

interface KanbanBoardProps {
  projectId?: string;
}

export const KanbanBoard = memo(function KanbanBoard({ projectId }: KanbanBoardProps) {
  const queryClient = useQueryClient();
  const [newTaskColumn, setNewTaskColumn] = useState<KanbanStatus | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  const { data, isLoading } = useQuery<{ kanban: Record<string, AgentTask[]> }>({
    queryKey: ['agent-tasks', projectId],
    queryFn: async () => {
      const params = projectId ? `?project_id=${projectId}` : '';
      return (await apiClient.get(`/agent-tasks${params}`)).data;
    },
    staleTime: 10_000,
  });

  const moveTask = useMutation({
    mutationFn: async ({ taskId, status }: { taskId: string; status: string }) => {
      return (await apiClient.patch(`/agent-tasks/${taskId}/move`, { status, sort_order: 0 })).data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-tasks'] }),
  });

  const createTask = useMutation({
    mutationFn: async ({ title, status }: { title: string; status: string }) => {
      return (await apiClient.post('/agent-tasks', {
        title, status, project_id: projectId, priority: 'medium',
      })).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-tasks'] });
      setNewTaskColumn(null);
      setNewTaskTitle('');
    },
  });

  const deleteTask = useMutation({
    mutationFn: async (taskId: string) => {
      return (await apiClient.delete(`/agent-tasks/${taskId}`)).data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-tasks'] }),
  });

  const kanban = data?.kanban || {};

  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-4">
        {COLUMNS.map((col) => (
          <div key={col.id} className="flex-shrink-0 w-64 h-64 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
      {COLUMNS.map((col) => {
        const tasks = kanban[col.id] || [];
        const Icon = col.icon;

        return (
          <div
            key={col.id}
            className="flex-shrink-0 w-64 flex flex-col rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50"
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-primary-400/40'); }}
            onDragLeave={(e) => { e.currentTarget.classList.remove('ring-2', 'ring-primary-400/40'); }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('ring-2', 'ring-primary-400/40');
              const taskId = e.dataTransfer.getData('taskId');
              if (taskId) moveTask.mutate({ taskId, status: col.id });
            }}
          >
            {/* Column header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
              <div className="flex items-center gap-1.5">
                <Icon className={cn('w-3.5 h-3.5', col.color)} />
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{col.label}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-mono text-slate-400 bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 rounded-full">
                  {tasks.length}
                </span>
                <button
                  onClick={() => setNewTaskColumn(col.id)}
                  className="p-0.5 text-slate-400 hover:text-primary-500 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Cards */}
            <div className="flex-1 p-2 space-y-2 min-h-[120px] max-h-[500px] overflow-y-auto">
              {/* New task input */}
              {newTaskColumn === col.id && (
                <div className="bg-white dark:bg-slate-800 rounded-lg border border-primary-300 dark:border-primary-600 p-2 shadow-sm">
                  <input
                    autoFocus
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newTaskTitle.trim()) {
                        createTask.mutate({ title: newTaskTitle, status: col.id });
                      }
                      if (e.key === 'Escape') { setNewTaskColumn(null); setNewTaskTitle(''); }
                    }}
                    placeholder="Task title..."
                    className="w-full text-xs bg-transparent border-none outline-none text-slate-800 dark:text-slate-200 placeholder-slate-400"
                  />
                  <div className="flex justify-end gap-1 mt-1.5">
                    <button
                      onClick={() => { setNewTaskColumn(null); setNewTaskTitle(''); }}
                      className="text-[10px] text-slate-400 hover:text-slate-600 px-1.5 py-0.5"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => newTaskTitle.trim() && createTask.mutate({ title: newTaskTitle, status: col.id })}
                      className="text-[10px] text-primary-600 font-medium hover:text-primary-700 px-1.5 py-0.5"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}

              {tasks.map((task) => {
                const pri = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium;
                const PriIcon = pri.icon;

                return (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('taskId', task.id);
                      (e.currentTarget as HTMLElement).style.opacity = '0.5';
                    }}
                    onDragEnd={(e) => {
                      (e.currentTarget as HTMLElement).style.opacity = '1';
                    }}
                    className={cn(
                      'bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700/50 p-2.5',
                      'hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm',
                      'transition-all duration-200 cursor-grab active:cursor-grabbing group',
                      task.status === 'in_progress' && 'border-l-2 border-l-cyan-400',
                      task.status === 'blocked' && 'border-l-2 border-l-red-400',
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium text-slate-800 dark:text-slate-200 leading-snug flex-1">
                        {task.title}
                      </p>
                      <button
                        onClick={() => deleteTask.mutate(task.id)}
                        className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 transition-all p-0.5"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5 mt-2">
                      <PriIcon className={cn('w-3 h-3', pri.color)} />
                      {task.labels && Array.isArray(task.labels) && task.labels.slice(0, 2).map((label: string, i: number) => (
                        <Badge key={i} className="text-[8px] px-1 py-0 bg-slate-100 dark:bg-slate-700 text-slate-500">
                          {label}
                        </Badge>
                      ))}
                    </div>

                    {task.progress > 0 && task.progress < 100 && (
                      <div className="mt-2 h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div className="h-full bg-cyan-400 rounded-full transition-all" style={{ width: `${task.progress}%` }} />
                      </div>
                    )}

                    {(task.tokens_used > 0 || task.cost_cents > 0) && (
                      <div className="flex items-center gap-2 mt-1.5 text-[9px] text-slate-400">
                        {task.tokens_used > 0 && <span>{(task.tokens_used / 1000).toFixed(1)}K tokens</span>}
                        {task.cost_cents > 0 && <span>${(task.cost_cents / 100).toFixed(2)}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
});
