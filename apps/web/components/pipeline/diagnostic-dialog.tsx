'use client';

/**
 * SDK-experimental: Diagnostic Dialog
 *
 * Triggers the Claude SDK diagnostic agent against the current pipeline run
 * and displays the structured root-cause + suggested-fixes report.
 *
 * NET-NEW component — does not replace any existing pipeline UI.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Stethoscope, Loader2, X, AlertTriangle, AlertCircle,
  CheckCircle2, Wrench, ArrowRight,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Button } from '@revamp/ui/components/button';
import { Badge } from '@revamp/ui/components/badge';

interface DiagnosticReport {
  runId: string;
  status: 'healthy' | 'degraded' | 'failed';
  rootCause: string;
  affectedStages: string[];
  findings: Array<{
    severity: 'critical' | 'major' | 'minor';
    stage: string;
    issue: string;
    evidence: string;
  }>;
  suggestedFixes: Array<{
    priority: 'P0' | 'P1' | 'P2';
    action: string;
    rationale: string;
  }>;
  nextSteps: string[];
  toolCallsCount: number;
  durationMs: number;
}

interface DiagnosticDialogProps {
  pipelineRunId: string | null;
}

export function DiagnosticDialog({ pipelineRunId }: DiagnosticDialogProps) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<DiagnosticReport | null>(null);

  const diagnose = useMutation({
    mutationFn: async () => {
      if (!pipelineRunId) throw new Error('No pipeline run');
      try {
        const res = await apiClient.post<DiagnosticReport>(`/pipeline/${pipelineRunId}/diagnose`);
        return res.data;
      } catch (err: any) {
        // Surface the real backend error message
        const backendError = err?.response?.data?.error;
        if (backendError) throw new Error(backendError);
        throw err;
      }
    },
    onSuccess: (data) => {
      setReport(data);
    },
  });

  const handleOpen = () => {
    setOpen(true);
    setReport(null);
    diagnose.mutate();
  };

  const handleClose = () => {
    setOpen(false);
    setReport(null);
    diagnose.reset();
  };

  return (
    <>
      <button
        onClick={handleOpen}
        disabled={!pipelineRunId}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="Run diagnostic agent"
      >
        <Stethoscope className="w-3.5 h-3.5" />
        Diagnose
      </button>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6" onClick={handleClose}>
          <div
            className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <Stethoscope className="w-4 h-4 text-primary-600" />
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Pipeline Diagnostic
                </h2>
                <Badge className="text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400">
                  SDK-experimental
                </Badge>
              </div>
              <button onClick={handleClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-5">
              {diagnose.isPending && (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <Loader2 className="w-8 h-8 text-primary-600 animate-spin" />
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Agent investigating pipeline run...
                  </p>
                  <p className="text-xs text-slate-400">
                    Reading artifacts, validation results, and subtask data
                  </p>
                </div>
              )}

              {diagnose.isError && (
                <div className="flex items-start gap-3 p-4 rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-red-700 dark:text-red-400">
                      Diagnostic failed
                    </p>
                    <pre className="text-[11px] text-red-600 dark:text-red-300 mt-1 whitespace-pre-wrap break-words font-mono">
                      {diagnose.error instanceof Error ? diagnose.error.message : 'Unknown error'}
                    </pre>
                  </div>
                </div>
              )}

              {report && (
                <div className="space-y-4">
                  {/* Status banner */}
                  <div className={cn(
                    'flex items-center gap-3 p-3 rounded-lg border',
                    report.status === 'healthy' && 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800',
                    report.status === 'degraded' && 'bg-amber-50 dark:bg-amber-900/10 border-amber-200 dark:border-amber-800',
                    report.status === 'failed' && 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800',
                  )}>
                    {report.status === 'healthy' && <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />}
                    {report.status === 'degraded' && <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />}
                    {report.status === 'failed' && <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />}
                    <div className="flex-1">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-50">
                        Status: {report.status.toUpperCase()}
                      </p>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                        {report.rootCause}
                      </p>
                    </div>
                    <div className="text-right text-[10px] text-slate-400">
                      <div>{report.toolCallsCount} tool calls</div>
                      <div>{(report.durationMs / 1000).toFixed(1)}s</div>
                    </div>
                  </div>

                  {/* Affected stages */}
                  {report.affectedStages.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-slate-500">Affected:</span>
                      {report.affectedStages.map(s => (
                        <Badge key={s} className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Findings */}
                  {report.findings.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                        Findings ({report.findings.length})
                      </h3>
                      <div className="space-y-2">
                        {report.findings.map((f, i) => (
                          <div key={i} className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge className={cn(
                                'text-[10px]',
                                f.severity === 'critical' && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                                f.severity === 'major' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                                f.severity === 'minor' && 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
                              )}>
                                {f.severity}
                              </Badge>
                              <span className="text-[10px] font-mono text-slate-500">{f.stage}</span>
                            </div>
                            <p className="text-xs font-medium text-slate-900 dark:text-slate-100">{f.issue}</p>
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 font-mono">{f.evidence}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Suggested fixes */}
                  {report.suggestedFixes.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
                        <Wrench className="w-3 h-3" />
                        Suggested Fixes ({report.suggestedFixes.length})
                      </h3>
                      <div className="space-y-2">
                        {report.suggestedFixes.map((fix, i) => (
                          <div key={i} className="p-3 rounded-lg border border-primary-200 dark:border-primary-800/40 bg-primary-50 dark:bg-primary-900/10">
                            <div className="flex items-start gap-2">
                              <Badge className={cn(
                                'text-[10px] shrink-0',
                                fix.priority === 'P0' && 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400',
                                fix.priority === 'P1' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                                fix.priority === 'P2' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
                              )}>
                                {fix.priority}
                              </Badge>
                              <div className="flex-1">
                                <p className="text-xs font-medium text-slate-900 dark:text-slate-100">{fix.action}</p>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{fix.rationale}</p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Next steps */}
                  {report.nextSteps.length > 0 && (
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                        Next Steps
                      </h3>
                      <ul className="space-y-1">
                        {report.nextSteps.map((step, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
                            <ArrowRight className="w-3 h-3 text-primary-500 shrink-0 mt-0.5" />
                            {step}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            {report && (
              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-700">
                <Button size="sm" variant="outline" onClick={() => diagnose.mutate()}>
                  Re-run Diagnostic
                </Button>
                <Button size="sm" onClick={handleClose}>
                  Close
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
