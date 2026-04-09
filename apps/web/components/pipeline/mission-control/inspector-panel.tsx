'use client';

import { memo, useMemo, useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import {
  ShieldCheck,
  CheckCircle,
  FileBox,
  Route,
  Play,
  XCircle,
  RotateCcw,
  Clock,
} from 'lucide-react';
import { ConfidenceGauge } from '@/components/pipeline/confidence-gauge';
import { ValidationResults } from '@/components/pipeline/validation-results';
import { ApprovalGate } from '@/components/pipeline/approval-gate';
import { apiClient } from '@/lib/api-client';
import type { StageState } from '@/lib/stores/pipeline-store';
import { usePipelineStore, shouldShowApprovalGate } from '@/lib/stores/pipeline-store';
import { useUIPreferencesStore, type InspectorTab } from '@/lib/stores/ui-preferences-store';
import { useStageTrajectory } from '@/lib/hooks/use-agents';
import type { RetrievalStep } from '@/lib/hooks/use-agents';

// ─── Tab Config ─────────────────────────────────────────────────

const INSPECTOR_TABS: {
  id: InspectorTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: 'validation', label: 'Validation', icon: ShieldCheck },
  { id: 'approval', label: 'Approval', icon: CheckCircle },
  { id: 'artifacts', label: 'Artifacts', icon: FileBox },
  { id: 'context', label: 'Context', icon: Route },
];

// ─── Component ──────────────────────────────────────────────────

interface InspectorPanelProps {
  /** Current stage state */
  stage: StageState;
  /** Approval handlers */
  onApprove: (comment?: string) => void;
  onReject: (reason: string) => void;
  onRerun?: (promptOverride?: string) => void;
  /** Current user role for approval gates */
  userRole: string;
  /** Pipeline run ID for context retrieval trajectory */
  pipelineRunId?: string;
  /** Project confidence threshold (overrides default 75%) */
  confidenceThreshold?: number;
  /** Auto-approval settings from project */
  autoApprovalEnabled?: boolean;
  autoApprovalTimeoutHours?: number;
  className?: string;
}

export const InspectorPanel = memo(function InspectorPanel({
  stage,
  onApprove,
  onReject: _onReject,
  onRerun,
  userRole,
  pipelineRunId,
  confidenceThreshold,
  autoApprovalEnabled,
  autoApprovalTimeoutHours,
  className,
}: InspectorPanelProps) {
  // Use individual selectors to avoid full-store re-renders
  const inspectorTab = useUIPreferencesStore((s) => s.inspectorTab);
  const setInspectorTab = useUIPreferencesStore((s) => s.setInspectorTab);

  const handleTabClick = useCallback(
    (tabId: InspectorTab) => setInspectorTab(tabId),
    [setInspectorTab],
  );

  // Determine which tabs should show notification badges
  const hasValidation = !!stage.validation;
  const hasApproval = stage.approvalStatus === 'pending';
  const hasArtifacts = stage.artifacts.length > 0;

  // Determine required role for approval
  const approvalRequiredRole = useMemo(() => {
    const stagesRequiringArchitect = ['BLUEPRINT', 'SPEC_LOCK', 'ARCHITECT'];
    const stagesRequiringAdmin = ['SHADOW_RUN'];
    if (stagesRequiringAdmin.includes(stage.name)) return 'admin';
    if (stagesRequiringArchitect.includes(stage.name)) return 'architect';
    return 'developer';
  }, [stage.name]);

  // Fetch full validation artifact from API for detailed breakdown
  const { data: validationArtifact } = useQuery<any>({
    queryKey: ['validation-detail', pipelineRunId, stage.name],
    queryFn: async () => {
      try {
        const res = await apiClient.get(`/pipeline/${pipelineRunId}/validation/${stage.name}`);
        return res.data;
      } catch {
        // 404 is expected for stages without validation artifacts — return null silently
        return null;
      }
    },
    enabled: !!pipelineRunId && (stage.status === 'completed' || stage.status === 'approved'),
    staleTime: 30_000,
    retry: false,
  });

  // Memoize the validation prop object — merge store data with API artifact for full breakdown
  const validationProp = useMemo(() => {
    if (!stage.validation && !validationArtifact) return null;
    const criteria = stage.validation?.criteria ?? [];
    const va = validationArtifact;
    return {
      passed: va?.passed ?? stage.validation?.passed ?? false,
      confidenceScore: va?.confidenceScore ?? stage.validation?.score ?? 0,
      issues: criteria
        .filter((c) => !c.passed)
        .map((c, i) => ({
          id: `issue-${i}`,
          severity: (c.score < 50 ? 'critical' : 'warning') as 'critical' | 'warning',
          title: c.name,
          description: c.feedback,
        })),
      recommendations: va?.recommendations ??
        (stage.validation?.summary ? [stage.validation.summary] : []),
      deterministicResults: va?.deterministicResults ?? [],
      llmResults: va?.llmResults ?? [],
      metadata: va?.metadata ?? undefined,
    };
  }, [stage.validation, validationArtifact]);

  // Right panel shown when stage has completed, approved, has output, validation,
  // or the API returned validation data (covers all rehydration timing)
  const stageCompleted = stage.status === 'completed' || stage.status === 'approved'
    || !!stage.output || !!stage.validation || !!validationArtifact;

  if (!stageCompleted) {
    return (
      <div className={cn('flex flex-col h-full items-center justify-center text-center p-6', className)}>
        <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-3">
          {stage.status === 'failed' ? (
            <RotateCcw className="w-5 h-5 text-amber-400" />
          ) : stage.status === 'generating' || stage.status === 'validating' ? (
            <div className="w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <ShieldCheck className="w-5 h-5 text-slate-300 dark:text-slate-600" />
          )}
        </div>
        <p className="text-sm font-medium text-slate-600 dark:text-slate-300">
          {stage.status === 'failed' ? 'Stage failed' :
           stage.status === 'generating' ? 'Generating...' :
           stage.status === 'validating' ? 'Validating...' :
           'Waiting for execution'}
        </p>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-[200px]">
          {stage.status === 'failed'
            ? 'Re-run the stage from the main panel.'
            : 'Validation, approval, and artifacts will appear here after the stage completes.'}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* ─── Tab Bar ──────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex overflow-x-auto">
          {INSPECTOR_TABS.map((tab) => {
            const isActive = inspectorTab === tab.id;
            const Icon = tab.icon;

            // Show notification dot
            const showDot =
              (tab.id === 'validation' && hasValidation) ||
              (tab.id === 'approval' && hasApproval) ||
              (tab.id === 'artifacts' && hasArtifacts);

            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab.id)}
                className={cn(
                  'relative flex items-center gap-1 px-3 py-2 text-[11px] font-medium whitespace-nowrap transition-colors',
                  isActive
                    ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-600 dark:border-primary-400'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
                )}
              >
                <Icon className="w-3 h-3" />
                {tab.label}
                {showDot && !isActive && (
                  <span className="absolute top-1.5 right-1 w-1.5 h-1.5 rounded-full bg-primary-500" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Tab Content ──────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-3">
        {/* Validation Tab */}
        {inspectorTab === 'validation' && (
          <div className="space-y-4">
            {validationProp ? (
              <>
                <div className="flex justify-center">
                  <ConfidenceGauge
                    score={validationProp.confidenceScore}
                    size={100}
                    label="Confidence"
                  />
                </div>
                <ValidationResults validation={validationProp} />
              </>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-slate-400 dark:text-slate-500">
                <ShieldCheck className="w-8 h-8 mb-2 opacity-50" />
                <p className="text-xs">No validation data yet</p>
                <p className="text-[10px] mt-1">Execute the stage to see results</p>
              </div>
            )}
          </div>
        )}

        {/* Approval Tab */}
        {inspectorTab === 'approval' && (
          <div className="space-y-4">
            {shouldShowApprovalGate(stage) ? (
              <ApprovalGate
                stage={stage.label}
                status={stage.approvalStatus === 'approved' ? 'approved' : 'pending'}
                requiredRole={approvalRequiredRole}
                onApprove={onApprove}
                onRerun={onRerun || (() => {})}
                userRole={userRole}
                validation={validationArtifact ? {
                  ...stage.validation,
                  score: validationArtifact.confidenceScore ?? stage.validation?.score ?? 0,
                  passed: validationArtifact.passed ?? stage.validation?.passed ?? false,
                  criteria: validationArtifact?.criteria ?? stage.validation?.criteria ?? [],
                  summary: validationArtifact?.summary ?? stage.validation?.summary ?? '',
                  validatedAt: validationArtifact?.validatedAt ?? stage.validation?.validatedAt ?? new Date().toISOString(),
                } : stage.validation}
                confidenceThreshold={confidenceThreshold}
                approvalHistory={stage.approvalHistory}
                autoApprovalEnabled={autoApprovalEnabled}
                autoApprovalTimeoutHours={autoApprovalTimeoutHours}
                pendingApprovalSince={stage.pendingApprovalSince}
              />
            ) : stage.status === 'failed' ? (
              <div className="flex flex-col items-center justify-center py-6 text-slate-400 dark:text-slate-500">
                <RotateCcw className="w-6 h-6 mb-2 text-amber-400" />
                <p className="text-sm font-medium text-slate-600 dark:text-slate-300">Stage failed</p>
                <p className="text-xs mt-1">Re-run the stage to generate output for review.</p>
                {onRerun && (
                  <button
                    onClick={() => onRerun?.()}
                    className="mt-3 px-3 py-1.5 text-xs font-medium rounded-md bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                  >
                    Re-run Stage
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-4 text-slate-400 dark:text-slate-500">
                <CheckCircle className="w-6 h-6 mb-1.5 opacity-50" />
                <p className="text-xs">
                  {stage.status === 'pending' || stage.status === 'idle'
                    ? 'Execute the stage first to enable approval review.'
                    : 'No approval gate for this stage.'}
                </p>
              </div>
            )}

            {/* Execution History Timeline */}
            <ExecutionTimeline stageName={stage.name} />
          </div>
        )}

        {/* Artifacts Tab — fetches from API for persistence across navigation */}
        {inspectorTab === 'artifacts' && (
          <ArtifactsTab pipelineRunId={pipelineRunId} stageName={stage.name} />
        )}

        {/* Context Retrieval Tab (OpenViking) */}
        {inspectorTab === 'context' && (
          <ContextRetrievalTab pipelineRunId={pipelineRunId} stageName={stage.name} />
        )}

      </div>
    </div>
  );
});

// ─── Context Retrieval Sub-component ─────────────────────────────

const TIER_COLORS: Record<string, string> = {
  L0: 'bg-slate-200 dark:bg-slate-600 text-slate-700 dark:text-slate-200',
  L1: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  L2: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
};

function ContextRetrievalTab({
  pipelineRunId,
  stageName,
}: {
  pipelineRunId?: string;
  stageName: string;
}) {
  const { data: trajectory, isLoading } = useStageTrajectory(pipelineRunId, stageName);

  if (!pipelineRunId) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-slate-400 dark:text-slate-500">
        <Route className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-xs">No pipeline run active</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-8 bg-slate-100 dark:bg-slate-700 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (!trajectory) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-slate-400 dark:text-slate-500">
        <Route className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-xs">No context retrieval data</p>
        <p className="text-[10px] mt-1">Execute the stage to see how context was assembled</p>
      </div>
    );
  }

  const tokensUsed = trajectory.tokensUsed ?? 0;
  const totalTokenBudget = trajectory.totalTokenBudget ?? 0;
  const buildDurationMs = trajectory.buildDurationMs ?? 0;
  const pct = totalTokenBudget > 0
    ? Math.round((tokensUsed / totalTokenBudget) * 100)
    : 0;
  const budgetColor = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="space-y-3">
      {/* Budget bar */}
      <div>
        <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-400 mb-1">
          <span>Token budget</span>
          <span className="font-mono tabular-nums">
            {tokensUsed.toLocaleString()} / {totalTokenBudget.toLocaleString()} ({pct}%)
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
          <div className={`h-full rounded-full ${budgetColor} transition-all`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 text-[10px] text-slate-400">
        <span className="font-mono tabular-nums">{buildDurationMs}ms build</span>
        {trajectory.evolutionMemoriesLoaded > 0 && (
          <span className="text-amber-500">{trajectory.evolutionMemoriesLoaded} memories loaded</span>
        )}
      </div>

      {/* Steps */}
      <div className="space-y-1">
        {(trajectory.trajectory ?? []).map((step: RetrievalStep, i: number) => {
          const isSkipped = step.reason === 'skipped_irrelevant';
          const isCompacted = step.compacted || step.reason === 'compaction_threshold';
          const reasonLabel = {
            recent_stage: 'Recent',
            high_relevance: 'Relevant',
            budget_overflow: 'Budget cap',
            skipped_irrelevant: 'Skipped',
            compaction_threshold: 'Compacted',
          }[step.reason] || step.reason;

          return (
            <div
              key={`${step.sourceStage}-${i}`}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded text-xs',
                isSkipped ? 'opacity-40' : '',
                isCompacted ? 'opacity-60 border-l-2 border-amber-400' : '',
              )}
            >
              <span className={cn('px-1 py-0.5 rounded text-[9px] font-mono font-semibold', TIER_COLORS[step.tierLoaded] || TIER_COLORS.L2)}>
                {step.tierLoaded}
              </span>
              <span className="font-mono text-slate-700 dark:text-slate-300 flex-1 truncate">
                {step.sourceStage}
              </span>
              <span className="text-[10px] text-slate-400">
                {reasonLabel}
              </span>
              <span className="text-slate-400 tabular-nums font-mono">
                {step.tokensConsumed.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      {/* L0 previews */}
      {(trajectory.trajectory ?? []).some((s: RetrievalStep) => s.l0Preview) && (
        <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-700">
          <p className="text-[10px] text-slate-400 mb-1.5">L0 Summaries</p>
          {trajectory.trajectory
            .filter((s: RetrievalStep) => s.l0Preview)
            .map((s: RetrievalStep, i: number) => (
              <div key={`preview-${i}`} className="text-[10px] text-slate-500 dark:text-slate-400 mb-1">
                <span className="font-mono text-slate-600 dark:text-slate-300">{s.sourceStage}:</span>{' '}
                {s.l0Preview}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Execution Timeline (shown under Approval tab) ─────────────

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

function ExecutionTimeline({ stageName }: { stageName: string }) {
  const pipelineRunId = usePipelineStore((s) => s.currentPipelineRunId);

  const { data } = useQuery<{ history: HistoryEntry[] }>({
    queryKey: ['pipeline-history', pipelineRunId],
    queryFn: async () => {
      const res = await apiClient.get(`/pipeline/${pipelineRunId}/history`);
      return res.data;
    },
    staleTime: 10_000,
    enabled: !!pipelineRunId,
  });

  // Filter to current stage only
  const history = (data?.history ?? []).filter(e => e.stage === stageName);

  if (history.length === 0) {
    return (
      <div className="px-3 py-4 text-center">
        <Clock className="w-5 h-5 mx-auto mb-1.5 text-slate-300 dark:text-slate-600" />
        <p className="text-[10px] text-slate-400">No execution history for this stage</p>
      </div>
    );
  }

  return (
    <div className="px-3 pb-3">
      <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wider mb-2">
        Execution History
      </p>
      <div className="relative">
        <div className="absolute left-[9px] top-2 bottom-2 w-px bg-slate-200 dark:bg-slate-700" />
        <div className="space-y-1">
          {history.map((entry, i) => {
            const isApproval = entry.type === 'approval';
            const isRejection = entry.type === 'rejection';
            const isRerun = entry.type === 'execution' && (entry.attempt ?? 1) > 1;

            const Icon = isApproval ? CheckCircle : isRejection ? XCircle : isRerun ? RotateCcw : Play;
            const iconColor = isApproval ? 'text-emerald-500' : isRejection ? 'text-red-500' : isRerun ? 'text-amber-500' : 'text-blue-500';

            const time = new Date(entry.timestamp);
            const dur = entry.duration_ms
              ? entry.duration_ms < 1000 ? `${entry.duration_ms}ms` : `${(entry.duration_ms / 1000).toFixed(1)}s`
              : null;

            return (
              <div key={`${entry.type}-${i}`} className="flex items-start gap-2 py-1.5 relative">
                <div className={cn('w-[18px] h-[18px] rounded-full flex items-center justify-center bg-white dark:bg-slate-900 z-10 ring-1 ring-slate-200 dark:ring-slate-700', iconColor)}>
                  <Icon className="w-2.5 h-2.5" />
                </div>
                <div className="flex-1 min-w-0 pt-px">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                      {isApproval ? 'Approved' : isRejection ? 'Rejected' : isRerun ? `Re-run #${entry.attempt}` : 'Executed'}
                    </span>
                    {entry.type === 'execution' && entry.validation_passed === false && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                        validation failed
                      </span>
                    )}
                    {entry.type === 'execution' && entry.validation_passed === true && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400">
                        passed
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500">
                    {entry.user} · {time.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {dur && ` · ${dur}`}
                  </p>
                  {entry.model && (
                    <p className="text-[9px] text-slate-400 dark:text-slate-500 font-mono truncate">{entry.model}</p>
                  )}
                  {entry.comment && (
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 italic mt-0.5">"{entry.comment}"</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Artifacts Tab (API-backed) ─────────────────────────────────

interface ApiArtifact {
  id: string;
  stage_name: string;
  artifact_type: string;
  storage_path: string;
  file_size: number;
  created_at: string;
  metadata?: Record<string, unknown>;
}

function ArtifactsTab({ pipelineRunId, stageName }: { pipelineRunId?: string; stageName: string }) {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: artifacts = [], isLoading } = useQuery<ApiArtifact[]>({
    queryKey: ['artifacts', pipelineRunId, stageName],
    queryFn: async () => {
      const res = await apiClient.get(`/pipeline/${pipelineRunId}/artifacts/${stageName}`);
      return (Array.isArray(res.data) ? res.data : res.data?.artifacts || []);
    },
    enabled: !!pipelineRunId,
    staleTime: 15_000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (artifactId: string) => {
      await apiClient.delete(`/pipeline/${pipelineRunId}/artifacts/${stageName}/${artifactId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['artifacts', pipelineRunId, stageName] });
    },
  });

  const { data: expandedArtifact } = useQuery<ApiArtifact>({
    queryKey: ['artifact-detail', expandedId],
    queryFn: async () => {
      const res = await apiClient.get(`/pipeline/${pipelineRunId}/artifacts/${stageName}/${expandedId}`);
      return res.data;
    },
    enabled: !!expandedId && !!pipelineRunId,
    staleTime: 60_000,
  });

  if (!pipelineRunId) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-slate-400 dark:text-slate-500">
        <FileBox className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-xs">No pipeline run active</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-10 bg-slate-100 dark:bg-slate-700 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-slate-400 dark:text-slate-500">
        <FileBox className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-xs">No artifacts yet</p>
        <p className="text-[10px] mt-1">Artifacts are generated during stage execution.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wider mb-2">
        {artifacts.length} artifact{artifacts.length !== 1 ? 's' : ''}
      </p>
      {artifacts.map((art) => {
        const displayName = art.artifact_type
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c: string) => c.toUpperCase());
        const sizeKB = art.file_size > 0 ? `${(art.file_size / 1024).toFixed(1)} KB` : '';
        const isExpanded = expandedId === art.id;

        return (
          <div key={art.id} className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedId(isExpanded ? null : art.id)}
              className="flex items-center gap-2 w-full p-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
            >
              <FileBox className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{displayName}</p>
                <p className="text-[9px] text-slate-400">
                  {new Date(art.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  {sizeKB ? ` · ${sizeKB}` : ''}
                </p>
              </div>
              <svg className={cn('w-3 h-3 text-slate-400 transition-transform', isExpanded && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isExpanded && (
              <div className="border-t border-slate-200 dark:border-slate-700 p-2 bg-slate-50 dark:bg-slate-800/30">
                {expandedArtifact?.metadata ? (
                  <pre className="text-[10px] text-slate-600 dark:text-slate-400 font-mono whitespace-pre-wrap max-h-60 overflow-auto leading-relaxed">
                    {JSON.stringify(expandedArtifact.metadata, null, 2)}
                  </pre>
                ) : (
                  <p className="text-[10px] text-slate-400">Loading...</p>
                )}
                <div className="flex justify-end mt-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(art.id); }}
                    disabled={deleteMutation.isPending}
                    className="text-[10px] text-red-500 hover:text-red-700 transition-colors"
                  >
                    {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
