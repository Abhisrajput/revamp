'use client';

import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowLeft, Clock, CheckCircle, XCircle, Play, RotateCcw, FileText, Cpu } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface StageArtifact {
  id: string;
  stage_name: string;
  artifact_type: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

interface HistoryEntry {
  type: 'execution' | 'approval' | 'rejection';
  stage: string;
  attempt?: number;
  status: string;
  user: string;
  model?: string | null;
  duration_ms?: number | null;
  validation_passed?: boolean | null;
  comment?: string | null;
  timestamp: string;
}

const STAGE_ORDER = ['SCAN', 'DECODE', 'BLUEPRINT', 'SPEC_LOCK', 'ARCHITECT', 'FORGE', 'SHADOW_RUN', 'EVOLVE'];
const STAGE_LABELS: Record<string, string> = {
  SCAN: 'Setup & Configuration', DECODE: 'Intent Extraction',
  BLUEPRINT: 'Business Capability Mining', SPEC_LOCK: 'Behavior Lock-in',
  ARCHITECT: 'Modernization Approach', FORGE: 'Co-Create',
  SHADOW_RUN: 'Parallel Run & Cutover', EVOLVE: 'Continuous Modernization',
};

// ─── Page ───────────────────────────────────────────────────────

export default function RunDetailPage() {
  const params = useParams();
  const projectId = params.id as string;
  const runId = params.runId as string;

  const { data: project } = useQuery<any>({
    queryKey: ['project', projectId],
    queryFn: async () => (await apiClient.get(`/projects/${projectId}`)).data,
  });

  const { data: runStatus } = useQuery<any>({
    queryKey: ['pipeline-status', runId],
    queryFn: async () => (await apiClient.get(`/pipeline/${runId}/status`)).data,
  });

  const { data: historyData } = useQuery<{ history: HistoryEntry[] }>({
    queryKey: ['pipeline-history', runId],
    queryFn: async () => (await apiClient.get(`/pipeline/${runId}/history`)).data,
  });

  const { data: artifactsData } = useQuery<any>({
    queryKey: ['pipeline-artifacts', runId],
    queryFn: async () => (await apiClient.get(`/pipeline/${runId}/artifacts`)).data,
    retry: 1,
  });

  const stageProgress = runStatus?.stage_progress ?? {};
  const history = historyData?.history ?? [];
  const stagePrompts = (project?.stage_prompts ?? {}) as Record<string, string>;
  const validationPrompts = (project?.validation_prompts ?? {}) as Record<string, string>;

  // Get stage outputs from artifacts
  const stageOutputs: Record<string, string> = {};
  const artifacts: StageArtifact[] = artifactsData?.artifacts ?? runStatus?.artifacts ?? [];
  for (const a of artifacts) {
    if (a.artifact_type === 'stage_output' && a.metadata) {
      stageOutputs[a.stage_name] = (a.metadata as any).output || (a.metadata as any).content || '';
    }
  }

  const completedStages = STAGE_ORDER.filter(s => {
    const status = stageProgress[s]?.status;
    return status === 'approved' || status === 'completed' || status === 'awaiting_approval';
  });

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href={`/projects/${projectId}`}
          className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-slate-400" />
        </Link>
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            Pipeline Run
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {project?.name || 'Loading...'} · <span className="font-mono">{runId.slice(0, 8)}</span>
            {runStatus?.started_at && (
              <> · {new Date(runStatus.started_at).toLocaleString()}</>
            )}
          </p>
        </div>
        <Badge className={
          runStatus?.status === 'completed'
            ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400 ml-auto'
            : runStatus?.status === 'failed'
              ? 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 ml-auto'
              : 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 ml-auto'
        }>
          {runStatus?.status || 'loading'}
        </Badge>
      </div>

      {/* Execution History Timeline */}
      {history.length > 0 && (
        <Card className="bg-white dark:bg-slate-800 p-5 mb-6">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            Execution History
          </h2>
          <div className="relative">
            <div className="absolute left-[9px] top-2 bottom-2 w-px bg-slate-200 dark:bg-slate-700" />
            <div className="space-y-2">
              {history.map((entry, i) => {
                const isApproval = entry.type === 'approval';
                const isRejection = entry.type === 'rejection';
                const isRerun = entry.type === 'execution' && (entry.attempt ?? 1) > 1;
                const Icon = isApproval ? CheckCircle : isRejection ? XCircle : isRerun ? RotateCcw : Play;
                const iconColor = isApproval ? 'text-emerald-500' : isRejection ? 'text-red-500' : isRerun ? 'text-amber-500' : 'text-blue-500';
                const dur = entry.duration_ms ? (entry.duration_ms < 1000 ? `${entry.duration_ms}ms` : `${(entry.duration_ms / 1000).toFixed(1)}s`) : null;

                return (
                  <div key={`${entry.type}-${i}`} className="flex items-start gap-2.5 py-1 relative">
                    <div className={`w-[18px] h-[18px] rounded-full flex items-center justify-center bg-white dark:bg-slate-900 z-10 ring-1 ring-slate-200 dark:ring-slate-700 ${iconColor}`}>
                      <Icon className="w-2.5 h-2.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        {isApproval ? 'Approved' : isRejection ? 'Rejected' : isRerun ? `Re-run #${entry.attempt}` : 'Executed'}
                        {' '}{STAGE_LABELS[entry.stage] || entry.stage}
                      </span>
                      <p className="text-[10px] text-slate-400 dark:text-slate-500">
                        {entry.user} · {new Date(entry.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {dur && ` · ${dur}`}
                        {entry.model && ` · ${entry.model}`}
                      </p>
                      {entry.comment && <p className="text-[10px] text-slate-500 italic mt-0.5">"{entry.comment}"</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* Per-Stage: Prompts + Output */}
      {completedStages.length === 0 && (
        <Card className="bg-white dark:bg-slate-800 p-8 text-center">
          <FileText className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No stages have been executed in this run yet.</p>
        </Card>
      )}

      {completedStages.map((stageName) => {
        const idx = STAGE_ORDER.indexOf(stageName);
        const prompt = stagePrompts[String(idx)] || '';
        const valPrompt = validationPrompts[String(idx)] || '';
        const output = stageOutputs[stageName] || '';
        const status = stageProgress[stageName]?.status || 'pending';

        return (
          <Card key={stageName} className="bg-white dark:bg-slate-800 mb-4 overflow-hidden">
            {/* Stage Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-700">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-slate-400 bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded">
                  {idx + 1}
                </span>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {STAGE_LABELS[stageName] || stageName}
                </h3>
              </div>
              <Badge className={
                status === 'approved' ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                  : status === 'completed' || status === 'awaiting_approval' ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }>
                {status}
              </Badge>
            </div>

            {/* Prompts */}
            {(prompt || valPrompt) && (
              <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50">
                {prompt && (
                  <div className="mb-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Cpu className="w-3 h-3 text-slate-400" />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Execution Prompt</span>
                    </div>
                    <pre className="text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap font-mono bg-white dark:bg-slate-900 p-3 rounded-md border border-slate-200 dark:border-slate-700 max-h-40 overflow-y-auto">
                      {prompt}
                    </pre>
                  </div>
                )}
                {valPrompt && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1">
                      <CheckCircle className="w-3 h-3 text-slate-400" />
                      <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Validation Prompt</span>
                    </div>
                    <pre className="text-[11px] text-slate-600 dark:text-slate-300 whitespace-pre-wrap font-mono bg-white dark:bg-slate-900 p-3 rounded-md border border-slate-200 dark:border-slate-700 max-h-40 overflow-y-auto">
                      {valPrompt}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Output */}
            <div className="px-5 py-4">
              {output ? (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <FileText className="w-3 h-3 text-slate-400" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Stage Output</span>
                    <span className="text-[10px] text-slate-400 ml-auto">{output.length.toLocaleString()} chars</span>
                  </div>
                  <div className="prose prose-sm dark:prose-invert max-w-none text-slate-700 dark:text-slate-300 text-[12px] leading-relaxed bg-white dark:bg-slate-900 p-4 rounded-md border border-slate-200 dark:border-slate-700 max-h-96 overflow-y-auto whitespace-pre-wrap font-mono">
                    {output}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400 text-center py-4">
                  Output not available — stage may still be processing
                </p>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
