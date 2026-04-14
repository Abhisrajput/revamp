'use client';

import { useState, memo, useMemo } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info, ChevronDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { cn } from '@/lib/utils';

// --- Types ---

interface ValidationIssue {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
}

interface DimensionScore {
  name: string;
  score: number;
  weight: number;
  status: string;
  message?: string;
  reasoning?: string;
}

interface ValidationData {
  passed: boolean;
  confidenceScore: number;
  issues: ValidationIssue[];
  recommendations: string[];
  deterministicResults?: DimensionScore[];
  llmResults?: DimensionScore[];
  metadata?: Record<string, unknown>;
}

interface ValidationResultsProps {
  validation: ValidationData;
}

// --- Severity Config ---

const severityConfig = {
  critical: { icon: XCircle, color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', label: 'Critical' },
  warning: { icon: AlertTriangle, color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-900/20', label: 'Warning' },
  info: { icon: Info, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20', label: 'Info' },
} as const;

type SeverityFilter = 'all' | 'critical' | 'warning' | 'info';

// --- Component ---

export const ValidationResults = memo(function ValidationResults({ validation }: ValidationResultsProps) {
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const [expanded, setExpanded] = useState(true);

  const issues = validation.issues ?? [];

  const filtered = useMemo(
    () => filter === 'all' ? issues : issues.filter((i) => i.severity === filter),
    [filter, issues],
  );

  const counts = useMemo(() => ({
    all: issues.length,
    critical: issues.filter((i) => i.severity === 'critical').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    info: issues.filter((i) => i.severity === 'info').length,
  }), [issues]);

  const scoreColor = validation.confidenceScore >= 80
    ? 'text-green-600 dark:text-green-400'
    : validation.confidenceScore >= 50
      ? 'text-yellow-600 dark:text-yellow-400'
      : 'text-red-600 dark:text-red-400';

  const barColor = validation.confidenceScore >= 80
    ? 'bg-green-600'
    : validation.confidenceScore >= 50
      ? 'bg-yellow-500'
      : 'bg-red-600';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">Validation Results</CardTitle>
            <Badge
              variant={validation.passed ? 'default' : 'destructive'}
              className={cn(
                validation.passed
                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-transparent'
                  : ''
              )}
            >
              {validation.passed ? (
                <><CheckCircle className="h-3 w-3 mr-1" /> Passed</>
              ) : (
                <><XCircle className="h-3 w-3 mr-1" /> Failed</>
              )}
            </Badge>
          </div>
          <button onClick={() => setExpanded(!expanded)}>
            <ChevronDown className={cn('h-5 w-5 text-slate-400 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent>
          {/* Confidence Score */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Confidence Score</span>
              <span className={cn('text-sm font-semibold tabular-nums', scoreColor)}>
                {validation.confidenceScore}%
              </span>
            </div>
            <div className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', barColor)}
                style={{ width: `${validation.confidenceScore}%` }}
              />
            </div>
          </div>

          {/* Deterministic Contract Checks */}
          {(validation.deterministicResults ?? []).length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                Deterministic Contract Checks
              </h4>
              <div className="space-y-1.5">
                {(validation.deterministicResults ?? []).map((dim, i) => {
                  const pct = Math.round((dim.score ?? 0) * 100);
                  const passed = dim.status === 'PASS';
                  return (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {passed ? (
                        <CheckCircle className="w-3.5 h-3.5 text-green-500 shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      )}
                      <span className="text-slate-600 dark:text-slate-300 flex-1 truncate">{dim.name}</span>
                      <div className="w-20 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={cn('h-full rounded-full', passed ? 'bg-green-400' : pct >= 40 ? 'bg-amber-400' : 'bg-red-400')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className={cn('font-mono w-8 text-right', passed ? 'text-green-600' : 'text-red-600')}>
                        {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* LLM Evaluation Dimensions */}
          {(validation.llmResults ?? []).length > 0 && (
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                LLM Evaluation
              </h4>
              <div className="space-y-1.5">
                {(validation.llmResults ?? []).map((dim, i) => {
                  const pct = Math.round((dim.score ?? 0) * 100);
                  return (
                    <div key={i}>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-600 dark:text-slate-300 w-28 truncate">{dim.name}</span>
                        <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                          <div
                            className={cn('h-full rounded-full', pct >= 75 ? 'bg-green-400' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400')}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className={cn('font-mono w-8 text-right', pct >= 70 ? 'text-green-600' : pct >= 50 ? 'text-amber-600' : 'text-red-600')}>
                          {pct}%
                        </span>
                        <span className="text-slate-400 w-8 text-right text-[9px]">{Math.round((dim.weight ?? 0) * 100)}%w</span>
                      </div>
                      {dim.reasoning && (
                        <p className="text-[10px] text-slate-400 ml-28 mt-0.5 leading-tight">{dim.reasoning}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Metadata (approach, ground truth, etc.) */}
          {validation.metadata && Object.keys(validation.metadata).length > 0 && (
            <div className="mb-4 p-2 rounded bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-700">
              <h4 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Validation Metadata</h4>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-slate-500">
                {Object.entries(validation.metadata).map(([k, v]) => (
                  <span key={k}><span className="text-slate-400">{k}:</span> {String(v)}</span>
                ))}
              </div>
            </div>
          )}

          {/* Issue Filters */}
          {issues.length > 0 && (
            <div className="flex gap-1 mb-3">
              {(['all', 'critical', 'warning', 'info'] as const).map((key) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    'px-2 py-1 rounded text-xs font-medium transition-colors',
                    filter === key
                      ? 'bg-primary-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
                  )}
                >
                  {key.charAt(0).toUpperCase() + key.slice(1)}
                  {counts[key] > 0 && ` (${counts[key]})`}
                </button>
              ))}
            </div>
          )}

          {/* Issue List */}
          {filtered.length > 0 && (
            <div className="space-y-2 mb-4">
              {filtered.map((issue) => {
                const cfg = severityConfig[issue.severity];
                const Icon = cfg.icon;
                return (
                  <div key={issue.id} className={cn('flex items-start gap-3 p-3 rounded-md border', cfg.bg)}>
                    <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', cfg.color)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-50">{issue.title}</p>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{issue.description}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {cfg.label}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}

          {issues.length === 0 && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 mb-4">
              <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
              <span className="text-sm text-green-700 dark:text-green-400">No issues found</span>
            </div>
          )}

          {/* Recommendations */}
          {(validation.recommendations ?? []).length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-2">Recommendations</h4>
              <ul className="space-y-1.5">
                {(validation.recommendations ?? []).map((rec, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-400">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary-600 mt-1.5 shrink-0" />
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
});
