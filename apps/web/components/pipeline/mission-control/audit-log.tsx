'use client';

import { memo, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Cpu, FileText, GitBranch, Shield, Settings, Users, Layers } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  action: string;
  category: string;
  user_id: string;
  user_email: string;
  details: string;
  created_at: string;
}

type AuditCategory = 'all' | 'ai' | 'file' | 'git' | 'auth' | 'settings' | 'member' | 'template';

// ─── Category Config ────────────────────────────────────────────

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

// ─── Component ──────────────────────────────────────────────────

interface AuditLogProps {
  projectId: string;
  className?: string;
}

export const AuditLog = memo(function AuditLog({
  projectId,
  className,
}: AuditLogProps) {
  const [activeCategory, setActiveCategory] = useState<AuditCategory>('all');

  const { data: entries, isLoading } = useQuery<AuditEntry[]>({
    queryKey: ['audit-logs', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/audit-logs?project_id=${projectId}&limit=100`);
      return res.data?.logs ?? res.data ?? [];
    },
    staleTime: 15_000,
    enabled: !!projectId,
  });

  const filtered = useMemo(() => {
    if (!entries) return [];
    if (activeCategory === 'all') return entries;
    return entries.filter((e) => e.category === activeCategory);
  }, [entries, activeCategory]);

  if (isLoading) {
    return (
      <div className={cn('p-4 space-y-2', className)}>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-8 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Category Filter Tabs */}
      <div className="flex-shrink-0 flex gap-1 px-3 pt-2 pb-1 overflow-x-auto">
        {(Object.entries(CATEGORY_CONFIG) as [AuditCategory, typeof CATEGORY_CONFIG[AuditCategory]][]).map(([key, cfg]) => {
          const Icon = cfg.icon;
          return (
            <button
              key={key}
              onClick={() => setActiveCategory(key)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap transition-colors',
                activeCategory === key
                  ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700',
              )}
            >
              <Icon className="w-3 h-3" />
              {cfg.label}
            </button>
          );
        })}
      </div>

      {/* Entries */}
      <div className="flex-1 overflow-auto px-3 pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-slate-400 dark:text-slate-500">
            <ClipboardList className="w-5 h-5 mb-1 opacity-50" />
            <p className="text-[10px]">No audit entries</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((entry) => {
              const catCfg = CATEGORY_CONFIG[entry.category as AuditCategory] ?? CATEGORY_CONFIG.all;
              const CatIcon = catCfg.icon;
              const time = new Date(entry.created_at);

              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 py-1.5 text-xs border-b border-slate-100 dark:border-slate-700/50 last:border-0"
                >
                  <CatIcon className="w-3 h-3 mt-0.5 text-slate-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-700 dark:text-slate-300 truncate">
                      <span className="font-medium">{entry.action}</span>
                      {entry.details && (
                        <span className="text-slate-400 dark:text-slate-500"> — {entry.details}</span>
                      )}
                    </p>
                    <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5">
                      {entry.user_email} &middot;{' '}
                      {time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
