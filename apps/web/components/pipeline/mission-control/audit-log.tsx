'use client';

import { memo, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Cpu, FileText, GitBranch, Shield, Settings, Users, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiClient } from '@/lib/api-client';
import { Badge } from '@revamp/ui/components/badge';

// ─── Types ──────────────────────────────────────────────────────

interface AuditLogEntry {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  user_id: string | null;
  user_display?: string | null;
  project_name?: string | null;
  changes: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

type AuditCategory = 'all' | 'ai' | 'file' | 'git' | 'auth' | 'settings' | 'member' | 'template';

const CATEGORY_CONFIG: Record<AuditCategory, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  all: { label: 'All', icon: ClipboardList },
  ai: { label: 'AI', icon: Cpu },
  file: { label: 'File', icon: FileText },
  git: { label: 'Git', icon: GitBranch },
  auth: { label: 'Auth', icon: Shield },
  settings: { label: 'Settings', icon: Settings },
  member: { label: 'Team', icon: Users },
  template: { label: 'Template', icon: Layers },
};

const ACTION_TO_CATEGORY: Record<string, AuditCategory> = {
  PIPELINE_STARTED: 'ai', STAGE_STARTED: 'ai', STAGE_COMPLETED: 'ai',
  STAGE_APPROVED: 'ai', STAGE_REJECTED: 'ai',
  LOGIN: 'auth', SIGNUP: 'auth', LOGOUT: 'auth', PASSWORD_RESET: 'auth',
  PROJECT_CREATED: 'settings', PROJECT_UPDATED: 'settings', PROJECT_DELETED: 'settings',
  FILE_UPLOADED: 'file', FILE_DELETED: 'file',
  MEMBER_ADDED: 'member', MEMBER_REMOVED: 'member', MEMBER_ROLE_CHANGED: 'member',
};

const ACTION_LABELS: Record<string, string> = {
  PIPELINE_STARTED: 'Pipeline Started', STAGE_STARTED: 'Stage Execution',
  STAGE_COMPLETED: 'Stage Completed', STAGE_APPROVED: 'Stage Approved', STAGE_REJECTED: 'Stage Rejected',
};
const ACTION_COLORS: Record<string, string> = {
  PIPELINE_STARTED: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  STAGE_STARTED: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  STAGE_COMPLETED: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300',
  STAGE_APPROVED: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
  STAGE_REJECTED: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300',
};

function getCategory(action: string): AuditCategory { return ACTION_TO_CATEGORY[action] || 'ai'; }

// ─── Component ──────────────────────────────────────────────────

interface AuditLogProps {
  projectId: string;
  className?: string;
}

export const AuditLog = memo(function AuditLog({ projectId, className }: AuditLogProps) {
  const [activeCategory, setActiveCategory] = useState<AuditCategory>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: entries, isLoading } = useQuery<AuditLogEntry[]>({
    queryKey: ['audit-logs-pipeline', projectId],
    queryFn: async () => {
      const res = await apiClient.get('/admin/audit-logs?limit=100');
      return (res.data?.logs ?? []).filter((l: AuditLogEntry) => {
        const changes = l.changes as Record<string, unknown> | null;
        return changes?.projectId === projectId || l.project_name;
      });
    },
    staleTime: 15_000,
    enabled: !!projectId,
  });

  const allLogs = entries ?? [];
  const logs = activeCategory === 'all' ? allLogs : allLogs.filter(l => getCategory(l.action) === activeCategory);

  const categoryCounts = useMemo(() => {
    const c: Record<AuditCategory, number> = { all: allLogs.length, ai: 0, file: 0, git: 0, auth: 0, settings: 0, member: 0, template: 0 };
    for (const l of allLogs) { const cat = getCategory(l.action); c[cat] = (c[cat] || 0) + 1; }
    return c;
  }, [allLogs]);

  if (isLoading) {
    return (
      <div className={cn('p-4 space-y-2', className)}>
        {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Category Filter Tabs */}
      <div className="flex-shrink-0 flex gap-1 px-3 pt-2 pb-1 overflow-x-auto">
        {(Object.entries(CATEGORY_CONFIG) as [AuditCategory, typeof CATEGORY_CONFIG[AuditCategory]][]).map(([key, cfg]) => {
          const Icon = cfg.icon;
          const count = categoryCounts[key as AuditCategory] || 0;
          return (
            <button
              key={key}
              onClick={() => setActiveCategory(key as AuditCategory)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap transition-colors',
                activeCategory === key
                  ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700',
              )}
            >
              <Icon className="w-3 h-3" />
              {cfg.label}
              {count > 0 && <span className="opacity-50">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Log Entries */}
      <div className="flex-1 overflow-auto px-3 pb-2">
        {logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-slate-400 dark:text-slate-500">
            <ClipboardList className="w-5 h-5 mb-1 opacity-50" />
            <p className="text-[10px]">No audit entries {activeCategory !== 'all' ? `in ${CATEGORY_CONFIG[activeCategory].label}` : ''}</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {logs.map((log) => {
              const isExpanded = expandedId === log.id;
              const details: string[] = [];
              const ch = log.changes ?? {};
              if (ch.stageName) details.push(`Stage: ${ch.stageName}`);
              if (ch.model) details.push(`${ch.model}`);
              if (ch.comment) details.push(`"${String(ch.comment).slice(0, 40)}"`);

              return (
                <div
                  key={log.id}
                  className="py-1.5 text-xs border-b border-slate-100 dark:border-slate-700/50 last:border-0 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 px-1 rounded transition-colors"
                  onClick={() => setExpandedId(isExpanded ? null : log.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge className={`${ACTION_COLORS[log.action] || 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'} text-[9px] px-1.5 py-0 shrink-0`}>
                        {ACTION_LABELS[log.action] || log.action.replace(/_/g, ' ')}
                      </Badge>
                      <span className="text-slate-600 dark:text-slate-300 truncate">
                        {log.user_display || 'system'}
                      </span>
                    </div>
                    <span className="text-[9px] text-slate-400 tabular-nums shrink-0">
                      {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {details.length > 0 && (
                    <p className="text-[10px] text-slate-400 dark:text-slate-500 truncate mt-0.5 pl-1">{details.join(' · ')}</p>
                  )}
                  {isExpanded && (
                    <div className="mt-2 p-2 bg-slate-50 dark:bg-slate-900 rounded text-[10px] space-y-1">
                      <div><span className="text-slate-400">User:</span> <span className="text-slate-600 dark:text-slate-300">{log.user_display || 'system'}</span></div>
                      <div><span className="text-slate-400">IP:</span> <span className="font-mono text-slate-600 dark:text-slate-300">{log.ip_address || '-'}</span></div>
                      {log.project_name && <div><span className="text-slate-400">Project:</span> <span className="text-slate-600 dark:text-slate-300">{log.project_name}</span></div>}
                      {log.changes && Object.keys(log.changes).length > 0 && (
                        <pre className="mt-1 p-1.5 bg-slate-100 dark:bg-slate-800 rounded text-[9px] overflow-x-auto text-slate-500">{JSON.stringify(log.changes, null, 2)}</pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
