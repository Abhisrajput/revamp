'use client';

import { useState, useMemo, memo } from 'react';
import { Search, ArrowUpDown, CheckCircle2, Clock, Loader2, FileCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// --- Types ---

export type TraceabilityStatus = 'planned' | 'in-progress' | 'complete' | 'verified';

export interface TraceabilityRow {
  id: string;
  /** Requirement from DECODE stage */
  requirement: string;
  /** Requirement ID or code (e.g. REQ-001) */
  requirementId?: string;
  /** Component generated in FORGE stage */
  component: string;
  /** Component file path */
  componentPath?: string;
  /** Implementation status */
  status: TraceabilityStatus;
  /** Coverage percentage 0-100 */
  coverage: number;
  /** Optional notes */
  notes?: string;
}

interface TraceabilityMatrixProps {
  rows: TraceabilityRow[];
  className?: string;
  /** Called when a row is clicked */
  onRowClick?: (row: TraceabilityRow) => void;
}

// --- Status Config ---

const STATUS_CONFIG: Record<TraceabilityStatus, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  planned: {
    label: 'Planned',
    color: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent',
    icon: Clock,
  },
  'in-progress': {
    label: 'In Progress',
    color: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-transparent',
    icon: Loader2,
  },
  complete: {
    label: 'Complete',
    color: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-transparent',
    icon: CheckCircle2,
  },
  verified: {
    label: 'Verified',
    color: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-transparent',
    icon: FileCheck,
  },
};

type SortField = 'requirement' | 'component' | 'status' | 'coverage';
type SortDirection = 'asc' | 'desc';

// --- Component ---

export const TraceabilityMatrix = memo(function TraceabilityMatrix({
  rows,
  className,
  onRowClick,
}: TraceabilityMatrixProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('requirement');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const filteredAndSorted = useMemo(() => {
    let result = rows;

    // Filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (r) =>
          r.requirement.toLowerCase().includes(q) ||
          r.component.toLowerCase().includes(q) ||
          (r.requirementId && r.requirementId.toLowerCase().includes(q)),
      );
    }

    // Sort
    result = [...result].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      switch (sortField) {
        case 'requirement':
          return dir * a.requirement.localeCompare(b.requirement);
        case 'component':
          return dir * a.component.localeCompare(b.component);
        case 'status': {
          const statusOrder: Record<TraceabilityStatus, number> = { planned: 0, 'in-progress': 1, complete: 2, verified: 3 };
          return dir * (statusOrder[a.status] - statusOrder[b.status]);
        }
        case 'coverage':
          return dir * (a.coverage - b.coverage);
        default:
          return 0;
      }
    });

    return result;
  }, [rows, searchQuery, sortField, sortDir]);

  // Summary stats
  const stats = useMemo(() => {
    const total = rows.length;
    const completed = rows.filter((r) => r.status === 'complete' || r.status === 'verified').length;
    const avgCoverage = total > 0 ? Math.round(rows.reduce((sum, r) => sum + r.coverage, 0) / total) : 0;
    return { total, completed, avgCoverage };
  }, [rows]);

  return (
    <div className={cn('rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <div className="flex items-center gap-2">
          <FileCheck className="w-4 h-4 text-slate-500" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Traceability Matrix
          </span>
          <Badge variant="secondary" className="text-[10px]">
            {stats.completed}/{stats.total} complete
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            Avg Coverage: <strong className="text-slate-700 dark:text-slate-300">{stats.avgCoverage}%</strong>
          </span>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Filter requirements or components..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-transparent text-slate-700 dark:text-slate-300 placeholder:text-slate-400 focus:outline-none"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30">
              {([
                { key: 'requirement' as SortField, label: 'Requirement', width: 'w-[35%]' },
                { key: 'component' as SortField, label: 'Component', width: 'w-[30%]' },
                { key: 'status' as SortField, label: 'Status', width: 'w-[15%]' },
                { key: 'coverage' as SortField, label: 'Coverage', width: 'w-[20%]' },
              ]).map(({ key, label, width }) => (
                <th key={key} className={cn('px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500', width)}>
                  <button
                    onClick={() => handleSort(key)}
                    className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                  >
                    {label}
                    <ArrowUpDown className="w-2.5 h-2.5" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredAndSorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                  {searchQuery ? 'No matching entries' : 'No traceability data available'}
                </td>
              </tr>
            ) : (
              filteredAndSorted.map((row) => {
                const statusCfg = STATUS_CONFIG[row.status];
                const StatusIcon = statusCfg.icon;
                return (
                  <tr
                    key={row.id}
                    onClick={() => onRowClick?.(row)}
                    className={cn(
                      'border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors',
                      onRowClick && 'cursor-pointer',
                    )}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex flex-col gap-0.5">
                        {row.requirementId && (
                          <span className="text-[10px] font-mono text-slate-400">{row.requirementId}</span>
                        )}
                        <span className="text-xs text-slate-700 dark:text-slate-300 line-clamp-2">
                          {row.requirement}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs font-mono text-slate-600 dark:text-slate-400">
                        {row.component}
                      </span>
                      {row.componentPath && (
                        <span className="block text-[10px] text-slate-400 truncate">
                          {row.componentPath}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge className={cn('text-[10px] gap-1', statusCfg.color)}>
                        <StatusIcon className={cn('w-3 h-3', row.status === 'in-progress' && 'animate-spin')} />
                        {statusCfg.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                          <div
                            className={cn(
                              'h-full rounded-full transition-all',
                              row.coverage >= 80 ? 'bg-green-500' :
                              row.coverage >= 50 ? 'bg-yellow-500' :
                              'bg-red-500',
                            )}
                            style={{ width: `${Math.min(100, Math.max(0, row.coverage))}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums text-slate-600 dark:text-slate-400 w-8 text-right">
                          {row.coverage}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});
