'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronRight, Command, Download, GitBranch, Settings2, PanelRight } from 'lucide-react';

import { MissionControlLayout } from '@/components/pipeline/mission-control/layout';
import { LeftRail } from '@/components/pipeline/mission-control/left-rail';
import { CenterPanel } from '@/components/pipeline/mission-control/center-panel';
import { InspectorPanel } from '@/components/pipeline/mission-control/inspector-panel';
import { BottomDock } from '@/components/pipeline/mission-control/bottom-dock';
import {
  CommandPalette,
  buildPaletteActions,
} from '@/components/pipeline/mission-control/command-palette';
import { GlobalTokenCounter } from '@/components/pipeline/mission-control/global-token-counter';
import { OnboardingOverlay } from '@/components/pipeline/mission-control/onboarding-overlay';
import { ExportDialog } from '@/components/pipeline/export-dialog';
import { GitHubSyncDialog } from '@/components/pipeline/github-sync-dialog';
import { DiagnosticDialog } from '@/components/pipeline/diagnostic-dialog';

import { usePipelineStore } from '@/lib/stores/pipeline-store';
import { usePipelineConfigStore } from '@/lib/stores/pipeline-config-store';
import { usePipelineActivityStore } from '@revamp/core';
import { canExecuteStage, getStageBlockReason } from '@revamp/core';
import { PIPELINE_STAGE_ORDER } from '@revamp/shared-types';
import { useUIPreferencesStore } from '@/lib/stores/ui-preferences-store';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useStageExecution } from '@/lib/hooks/use-stage-execution';
import { usePipelineShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
// IndexedDB caching handled by pipeline-store.setStageOutput (still uses pipeline-cache internally)
import { useLatestPipelineRun, usePipelineStatus, useAllStageOutputs } from '@revamp/core';

// ─── Page Component ─────────────────────────────────────────────

export default function PipelinePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const runIdFromUrl = searchParams.get('run');

  // ─── Auth ──────────────────────────────────────────────────
  const user = useAuthStore((s) => s.user);
  const authToken = useAuthStore((s) => s.token);
  const userRole = user?.role ?? 'developer';

  // ─── React Query: Single source of truth for pipeline data ──────
  // Get the correct run ID from the API, not from Zustand persistence
  const { data: apiRunId } = useLatestPipelineRun(projectId);
  const effectiveRunId = runIdFromUrl || apiRunId || null;

  // Fetch pipeline status (stage progress, approval gates)
  const { data: pipelineStatusData } = usePipelineStatus(effectiveRunId);

  // Batch-fetch ALL stage outputs (parallel, cached)
  const STAGE_NAMES = PIPELINE_STAGE_ORDER;
  const { data: allOutputs } = useAllStageOutputs(effectiveRunId, STAGE_NAMES);

  // Sync React Query data → Zustand store (one-way: RQ is source of truth)
  useEffect(() => {
    if (!effectiveRunId) return;
    const store = usePipelineStore.getState();
    if (store.currentPipelineRunId !== effectiveRunId || store.currentProjectId !== projectId) {
      store.initPipeline(projectId, effectiveRunId);
    }
    // Activity data is auto-restored from sessionStorage at store creation time —
    // no explicit restore needed here.
  }, [effectiveRunId, projectId]);

  // ─── Unified sync: React Query → Zustand (single effect) ──────
  // React Query owns the data (usePipelineStatus, useAllStageOutputs).
  // This single effect bridges it to Zustand for components that still
  // read from the store. As components migrate to usePipelineData,
  // this effect shrinks and eventually disappears.
  useEffect(() => {
    if (!pipelineStatusData?.stage_progress) return;
    const sp = pipelineStatusData.stage_progress;
    const gates = pipelineStatusData.approval_gates || [];
    const gateMap = new Map(gates.map((g: any) => [g.stage_name, g.status]));

    usePipelineStore.setState((state) => {
      const stages = [...state.stages];
      let changed = false;

      for (let i = 0; i < stages.length; i++) {
        const dbEntry = sp[stages[i].name] as any;
        if (!dbEntry?.status) continue;

        const dbStatus = dbEntry.status;
        const mapped = dbStatus === 'in_progress' ? 'generating'
          : dbStatus === 'awaiting_approval' ? 'completed'
          : dbStatus;

        const updates: Record<string, any> = {};

        // Status
        if (mapped !== stages[i].status) updates.status = mapped;

        // Timer: startedAt from server
        if (dbEntry.startedAt && dbEntry.startedAt !== stages[i].startedAt) {
          updates.startedAt = dbEntry.startedAt;
        }
        // Timer: pending clears, finished sets completedAt
        if (dbStatus === 'pending') {
          if (stages[i].startedAt || stages[i].completedAt) {
            updates.startedAt = null;
            updates.completedAt = null;
          }
        } else if (dbStatus !== 'in_progress' && dbEntry.updatedAt) {
          if (stages[i].completedAt !== dbEntry.updatedAt) {
            updates.completedAt = dbEntry.updatedAt;
          }
        }

        // Approval from gate
        const gateStatus = gateMap.get(stages[i].name);
        if (gateStatus === 'approved' && stages[i].approvalStatus !== 'approved') {
          updates.approvalStatus = 'approved';
          updates.status = 'approved';
        } else if (dbStatus === 'awaiting_approval' && stages[i].approvalStatus !== 'pending') {
          updates.approvalStatus = 'pending';
          updates.pendingApprovalSince = stages[i].pendingApprovalSince || new Date().toISOString();
        }

        // Confidence score
        if (dbEntry.confidenceScore !== undefined) {
          updates.confidenceScore = dbEntry.confidenceScore;
        }

        if (Object.keys(updates).length > 0) {
          stages[i] = { ...stages[i], ...updates };
          changed = true;
        }
      }

      // Subtasks — only update if API returned data (don't wipe existing on empty response)
      const currentStage = pipelineStatusData.current_stage;
      const subtaskRows = pipelineStatusData.current_stage_subtasks || [];
      const overallProgress = pipelineStatusData.current_stage_progress;
      if (currentStage && subtaskRows.length > 0) {
        const idx = stages.findIndex(s => s.name === currentStage);
        if (idx >= 0) {
          stages[idx] = {
            ...stages[idx],
            subtasks: (subtaskRows as any[]).map((r: any) => ({
              id: r.id, type: r.type, label: r.title, title: r.title,
              status: ['running', 'completed', 'failed', 'pending'].includes(r.status) ? r.status : 'pending',
              agentName: r.agent_name,
            })),
            subtaskProgress: overallProgress || stages[idx].subtaskProgress,
          };
          changed = true;
        }
      }

      return changed ? { stages, isGenerating: stages.some(s => s.status === 'generating' || s.status === 'validating') } : state;
    });
  }, [pipelineStatusData]);

  // Sync stage outputs from React Query → store
  useEffect(() => {
    if (!allOutputs) return;
    usePipelineStore.setState((state) => {
      const stages = [...state.stages];
      let changed = false;
      for (const [stageName, output] of Object.entries(allOutputs)) {
        if (!output) continue;
        const idx = stages.findIndex(s => s.name === stageName);
        if (idx >= 0 && (!stages[idx].output || stages[idx].output.includes('Partial Result'))) {
          stages[idx] = { ...stages[idx], output };
          changed = true;
        }
      }
      return changed ? { stages } : state;
    });
  }, [allOutputs]);

  // ─── Pipeline Store (granular selectors to avoid re-renders from streaming) ──
  const stages = usePipelineStore((s) => s.stages);
  const activeStageIndex = usePipelineStore((s) => s.activeStageIndex);

  // Persist active stage in sessionStorage so it survives page refresh.
  // Scoped per pipeline run so different runs don't collide.
  // IMPORTANT: skip the very first effect run after mount — at that point
  // activeStageIndex is the default 0, and writing it would clobber whatever
  // was saved before the refresh, defeating the entire purpose.
  const persistInitialized = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !effectiveRunId) return;
    // First run for this runId — don't persist, just mark initialized
    if (persistInitialized.current !== effectiveRunId) {
      persistInitialized.current = effectiveRunId;
      return;
    }
    try {
      sessionStorage.setItem(`revamp:activeStage:${effectiveRunId}`, String(activeStageIndex));
    } catch { /* sessionStorage unavailable — non-fatal */ }
  }, [activeStageIndex, effectiveRunId]);

  const currentPipelineRunId = effectiveRunId; // Use React Query run ID, not Zustand
  const streamingText = usePipelineStore((s) => s.streamingText);

  // Activity store (logs, toolCalls, usage, files)
  const toolCalls = usePipelineActivityStore((s) => s.toolCalls);
  const logs = usePipelineActivityStore((s) => s.logs);
  const runUsage = usePipelineActivityStore((s) => s.runUsage);

  // Config store (model/prompt overrides, template, deep analysis)
  const stageModelOverrides = usePipelineConfigStore((s) => s.stageModelOverrides);
  const stageEvaluatorModelOverrides = usePipelineConfigStore((s) => s.stageEvaluatorModelOverrides);
  const stageComposerModelOverrides = usePipelineConfigStore((s) => s.stageComposerModelOverrides);
  const stagePromptOverrides = usePipelineConfigStore((s) => s.stagePromptOverrides);
  const activeTemplateId = usePipelineConfigStore((s) => s.activeTemplateId);
  const deepAnalysis = usePipelineConfigStore((s) => s.deepAnalysis);

  // Actions (stable references — never trigger re-renders)
  const setActiveStage = usePipelineStore((s) => s.setActiveStage);
  const initPipeline = usePipelineStore((s) => s.initPipeline);
  const advanceToNextStage = usePipelineStore((s) => s.advanceToNextStage);
  const setStageApproval = usePipelineStore((s) => s.setStageApproval);
  const resetStage = usePipelineStore((s) => s.resetStage);
  const setStageModelOverride = usePipelineConfigStore((s) => s.setStageModelOverride);
  const setStageEvaluatorModelOverride = usePipelineConfigStore((s) => s.setStageEvaluatorModelOverride);
  const setStageComposerModelOverride = usePipelineConfigStore((s) => s.setStageComposerModelOverride);
  const setStagePromptOverride = usePipelineConfigStore((s) => s.setStagePromptOverride);
  const clearStagePromptOverride = usePipelineConfigStore((s) => s.clearStagePromptOverride);
  const stageValidationPromptOverrides = usePipelineConfigStore((s) => s.stageValidationPromptOverrides);
  const setStageValidationPromptOverride = usePipelineConfigStore((s) => s.setStageValidationPromptOverride);
  const clearStageValidationPromptOverride = usePipelineConfigStore((s) => s.clearStageValidationPromptOverride);
  const setActiveTemplateId = usePipelineConfigStore((s) => s.setActiveTemplateId);
  const setDeepAnalysis = usePipelineConfigStore((s) => s.setDeepAnalysis);

  // ─── UI Preferences Store ─────────────────────────────────
  const {
    promptEditorOpen,
    togglePromptEditor,
    toggleLeftRail,
    toggleRightPanel,
    toggleBottomDock,
    setCommandPaletteOpen,
    setExportDialogOpen,
    setGithubSyncOpen,
    exportDialogOpen,
    githubSyncOpen,
    leftRailCollapsed,
    rightPanelCollapsed,
    setRightPanelCollapsed,
  } = useUIPreferencesStore();

  // ─── Auto-collapse right panel until stage has output ──────
  // Show the inspector whenever the stage has output OR has completed/approved status,
  // so validation, approval gates, and artifacts are accessible even after navigation.
  const activeStageStatus2 = usePipelineStore((s) => s.stages[s.activeStageIndex]?.status);
  const activeStageHasOutput = usePipelineStore((s) => !!s.stages[s.activeStageIndex]?.output);
  const activeStageHasValidation = usePipelineStore((s) => !!s.stages[s.activeStageIndex]?.validation);
  const prevAutoCollapseRef = useRef<boolean | null>(null);
  useEffect(() => {
    const isDone = activeStageStatus2 === 'completed' || activeStageStatus2 === 'approved';
    const shouldShow = isDone || activeStageHasOutput || activeStageHasValidation;
    const shouldCollapse = !shouldShow;
    // Only update if the value actually changed to prevent loops
    if (prevAutoCollapseRef.current !== shouldCollapse) {
      prevAutoCollapseRef.current = shouldCollapse;
      setRightPanelCollapsed(shouldCollapse);
    }
  }, [activeStageStatus2, activeStageHasOutput, activeStageHasValidation, setRightPanelCollapsed]);

  // ─── Stage Execution ──────────────────────────────────────
  const {
    executeStage,
    isExecuting,
    abort,
    currentPhase,
  } = useStageExecution();

  const activeStage = stages[activeStageIndex];

  // Active stage output comes from React Query (via the allOutputs sync above).
  // No manual fetch needed — React Query handles caching and refetching.
  const queryClient = useQueryClient();

  // ─── Fetch project data ───────────────────────────────────
  const { data: project } = useQuery<any>({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const response = await apiClient.get(`/projects/${projectId}`);
      return response.data;
    },
    retry: 1,
  });

  // ─── Seed prompt overrides from project defaults ──────────
  // Maps numeric DB indices (0-7) to stage names (SCAN, DECODE, etc.)
  const STAGE_INDEX_TO_NAME = PIPELINE_STAGE_ORDER;

  useEffect(() => {
    if (!project) return;
    const configStore = usePipelineConfigStore.getState();
    const stagePrompts = (project.stage_prompts || {}) as Record<string, string>;
    const validationPrompts = (project.validation_prompts || {}) as Record<string, string>;

    // Seed ALL stages from DB — always sync DB prompts to store.
    // User edits are saved to DB via the save button, so DB is the source of truth.
    // Supports both stage-name keys (new) and numeric-index keys (legacy DB data).
    for (const [key, prompt] of Object.entries(stagePrompts)) {
      const stageName = PIPELINE_STAGE_ORDER.includes(key as any) ? key : STAGE_INDEX_TO_NAME[parseInt(key)];
      if (stageName && prompt) {
        configStore.setStagePromptOverride(stageName, prompt);
      }
    }
    for (const [key, prompt] of Object.entries(validationPrompts)) {
      const stageName = PIPELINE_STAGE_ORDER.includes(key as any) ? key : STAGE_INDEX_TO_NAME[parseInt(key)];
      if (stageName && prompt) {
        configStore.setStageValidationPromptOverride(stageName, prompt);
      }
    }
  }, [project]);

  // ─── Apply template prompts when template changes ──────────
  useEffect(() => {
    if (!activeTemplateId || !projectId) return;
    // Apply template via API — it merges template prompts with defaults and saves to project
    apiClient.post(`/projects/${projectId}/apply-template`, {
      template_id: activeTemplateId,
    }).then(() => {
      // Refresh project to get updated prompts
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    }).catch(() => {});
  }, [activeTemplateId, projectId]);

  // ─── Active stage restoration on mount ─────────────────────
  // Restore which stage tab the user was on before page refresh.
  // Uses: sessionStorage > backend current_stage > highest non-pending stage.
  const activeStageRestoredRef = useRef(false);
  useEffect(() => {
    if (activeStageRestoredRef.current || !pipelineStatusData?.stage_progress || !effectiveRunId) return;
    activeStageRestoredRef.current = true;

    const store = usePipelineStore.getState();
    if (store.activeStageIndex !== 0) return; // user already navigated

    let targetIdx = -1;
    // 1. Saved session navigation
    try {
      const saved = sessionStorage.getItem(`revamp:activeStage:${effectiveRunId}`);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed < store.stages.length) targetIdx = parsed;
      }
    } catch { /* non-fatal */ }
    // 2. Backend current_stage
    if (targetIdx < 0 && pipelineStatusData.current_stage) {
      targetIdx = store.stages.findIndex(st => st.name === pipelineStatusData.current_stage);
    }
    // 3. Highest non-pending stage
    if (targetIdx < 0) {
      const sp = pipelineStatusData.stage_progress;
      for (let i = store.stages.length - 1; i >= 0; i--) {
        if (sp[store.stages[i].name]?.status && sp[store.stages[i].name]?.status !== 'pending') {
          targetIdx = i; break;
        }
      }
    }
    if (targetIdx > 0) store.setActiveStage(targetIdx);
  }, [pipelineStatusData, effectiveRunId]);

  // Pipeline run creation handled by useLatestPipelineRun (React Query).
  // It calls POST /pipeline/start and caches the run ID.

  // Pipeline init now handled by React Query:
  //   useLatestPipelineRun → POST /pipeline/start → returns run ID
  //   usePipelineStatus → polls /pipeline/:id/status every 5-10s
  //   useAllStageOutputs → batch-fetches all outputs
  // The unified sync effect above bridges React Query → Zustand.
  // No manual syncStagesFromBackend needed.

  // Stuck stage recovery is handled by the unified sync effect above —
  // React Query polls every 5-10s, the sync detects stuck stages
  // (store says 'generating' but DB says 'completed') and corrects them.

  // ─── Refetch project data when SCAN completes (picks up folder_structure) ──
  const scanStatus = stages[0]?.status;
  useEffect(() => {
    if (scanStatus === 'completed' || scanStatus === 'approved') {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    }
  }, [scanStatus, projectId, queryClient]);

  // Stage output + validation rehydration is now handled by:
  //   useAllStageOutputs → React Query batch-fetches all outputs
  //   Unified sync effect → bridges to Zustand
  // Validation rehydration still needs a dedicated fetch per stage.
  // TODO: Move to useStageValidation hook per stage (Phase 1 follow-up).
  useEffect(() => {
    if (!effectiveRunId || !pipelineStatusData?.stage_progress) return;
    const sp = pipelineStatusData.stage_progress;
    const store = usePipelineStore.getState();

    // Fetch validation for stages that completed but have no validation in store
    const stagesToValidate = store.stages.filter((st) => {
      const dbStatus = (sp[st.name] as any)?.status;
      return dbStatus && dbStatus !== 'pending' && dbStatus !== 'in_progress' && !st.validation;
    });

    if (stagesToValidate.length === 0) return;

    for (const st of stagesToValidate) {
      apiClient.get(`/pipeline/${effectiveRunId}/artifacts/${st.name}`).then(res => {
        const artifacts = Array.isArray(res.data) ? res.data : [];
        const valArt = artifacts.find((a: any) => a.artifact_type === 'validation_result');
        if (!valArt?.metadata) return;

        const v = valArt.metadata;
        const criteria: Array<{ name: string; passed: boolean; score: number; feedback: string }> = [];

        if (Array.isArray(v.deterministicResults)) {
          for (const cr of v.deterministicResults) {
            criteria.push({
              name: cr.name || cr.type || 'Check',
              passed: cr.status === 'PASS',
              score: Math.round((cr.score ?? 0) * 100),
              feedback: cr.message || (cr.status === 'PASS' ? 'Passed' : 'Failed'),
            });
          }
        }
        if (Array.isArray(v.llmResults)) {
          for (const lr of v.llmResults) {
            criteria.push({
              name: lr.dimension || 'LLM Evaluation',
              passed: (lr.score ?? 0) >= 0.6,
              score: Math.round((lr.score ?? 0) * 100),
              feedback: lr.reasoning || '',
            });
          }
        }
        if (criteria.length === 0 && Array.isArray(v.issues)) {
          for (const issue of v.issues) {
            criteria.push({
              name: issue.title || issue.code || 'Issue',
              passed: issue.severity === 'INFO',
              score: issue.severity === 'ERROR' ? 0 : issue.severity === 'WARN' ? 50 : 80,
              feedback: issue.description || '',
            });
          }
        }

        const idx = usePipelineStore.getState().stages.findIndex(s => s.name === st.name);
        if (idx >= 0) {
          usePipelineStore.getState().setStageValidation(idx, {
            passed: v.passed ?? false,
            score: v.confidenceScore ?? 0,
            criteria,
            summary: Array.isArray(v.recommendations) ? v.recommendations.slice(0, 3).join('; ') : '',
            validatedAt: valArt.created_at ?? new Date().toISOString(),
          });
        }
      }).catch(() => { /* non-fatal */ });
    }
  }, [effectiveRunId, pipelineStatusData]);

  // Left rail stays open — stages moved to main sidebar, but settings/cost/docs remain here

  // ─── LLM Config State ───────────────────────────────────
  const [skipLlmEval, setSkipLlmEval] = useState(false);

  // ─── Handlers ─────────────────────────────────────────────

  const handleExecuteStage = useCallback(() => {
    // Kill any running execution first — prevents orphaned SSE connections and stale timers
    if (isExecuting) {
      abort();
      // Reset backend stage status so it's not stuck in 'in_progress'
      const s0 = usePipelineStore.getState();
      const activeStage0 = s0.stages[s0.activeStageIndex];
      if (s0.currentPipelineRunId && activeStage0) {
        apiClient.post(`/pipeline/${s0.currentPipelineRunId}/reset/${activeStage0.name}`, {}).catch(() => {});
      }
    }

    // Read state at call time to avoid stale closures with granular selectors
    const s = usePipelineStore.getState();
    const stage = s.stages[s.activeStageIndex];
    if (!s.currentPipelineRunId || !stage) {
      throw new Error(
        !s.currentPipelineRunId
          ? 'Pipeline run not initialized — please reload the page.'
          : 'No active stage selected.',
      );
    }
    // Guardrail: check prerequisites before execution
    if (!canExecuteStage(s.stages, s.activeStageIndex)) {
      const reason = getStageBlockReason(s.stages, s.activeStageIndex) || 'Stage prerequisites not met.';
      throw new Error(reason);
    }
    // Reset completed/failed/generating stages before re-executing
    if (stage.status === 'completed' || stage.status === 'failed' || stage.status === 'generating') {
      resetStage(s.activeStageIndex);
    }
    // Read model overrides from the config store
    const cfg = usePipelineConfigStore.getState();
    const modelOverride = cfg.stageModelOverrides[stage.name];
    const composerOverride = cfg.stageComposerModelOverrides[stage.name];
    const evaluatorOverride = cfg.stageEvaluatorModelOverrides[stage.name];
    executeStage(s.currentPipelineRunId, stage.name, {
      skipLlmEval,
      model: modelOverride || undefined,
      composerModel: composerOverride || undefined,
      evaluatorModel: evaluatorOverride || undefined,
      maxTokens: deepAnalysis ? 65536 : undefined,
    });
  }, [executeStage, skipLlmEval, resetStage, deepAnalysis]);

  const handleRerunStage = useCallback((promptOverride?: string) => {
    // Kill any running execution first
    if (isExecuting) {
      abort();
    }

    const s = usePipelineStore.getState();
    const stage = s.stages[s.activeStageIndex];
    if (!s.currentPipelineRunId || !stage) return;
    // Guardrail: check prerequisites before re-run
    if (s.activeStageIndex > 0) {
      for (let i = 0; i < s.activeStageIndex; i++) {
        const prior = s.stages[i];
        if (prior.status !== 'completed' && prior.status !== 'approved') return;
      }
    }

    // Capture validation feedback from the current run to feed back on re-run
    const validationFeedback = stage.validation?.criteria?.map(c => ({
      name: c.name,
      passed: c.passed,
      score: c.score,
      feedback: c.feedback,
      severity: c.passed ? 'info' : c.score < 50 ? 'critical' : 'warning',
    }));

    // Use rerunStage for cascade + history tracking, then re-execute
    const rerunStage = usePipelineStore.getState().rerunStage;
    if (rerunStage) {
      rerunStage(s.activeStageIndex);
    } else {
      resetStage(s.activeStageIndex);
    }
    // Reset backend stage progress before re-executing
    if (s.currentPipelineRunId) {
      apiClient.post(`/pipeline/${s.currentPipelineRunId}/reset/${stage.name}`, {}).catch(() => {});
    }
    setTimeout(() => {
      const updated = usePipelineStore.getState();
      const cfgUpdated = usePipelineConfigStore.getState();
      const modelOverride = cfgUpdated.stageModelOverrides[stage.name];
      const composerOverride = cfgUpdated.stageComposerModelOverrides[stage.name];
      const evaluatorOverride = cfgUpdated.stageEvaluatorModelOverrides[stage.name];
      executeStage(updated.currentPipelineRunId!, stage.name, {
        skipLlmEval,
        promptOverride,
        model: modelOverride || undefined,
        composerModel: composerOverride || undefined,
        evaluatorModel: evaluatorOverride || undefined,
        validationFeedback: validationFeedback?.length ? validationFeedback : undefined,
        maxTokens: deepAnalysis ? 65536 : undefined,
      });
    }, 100);
  }, [resetStage, executeStage, skipLlmEval]);

  const handleAdvance = useCallback(() => {
    advanceToNextStage();
  }, [advanceToNextStage]);

  const handleApprove = useCallback(
    async (comment?: string) => {
      const s = usePipelineStore.getState();
      const stage = s.stages[s.activeStageIndex];
      if (!s.currentPipelineRunId || !stage) return;
      // Guard: allow approval if stage has completed or has output (covers rehydration)
      const canApprove = (stage.status === 'completed' || !!stage.output) && stage.approvalStatus !== 'approved';
      if (!canApprove) return;
      try {
        await apiClient.post(
          `/pipeline/${s.currentPipelineRunId}/approve/${stage.name}`,
          { comment },
        );
        // Optimistic update for immediate UI feedback
        setStageApproval(s.activeStageIndex, 'approved');
        usePipelineStore.getState().setStageStatus(s.activeStageIndex, 'approved');
        // Immediately refetch pipeline status so React Query cache matches DB
        queryClient.invalidateQueries({ queryKey: ['pipeline-status', s.currentPipelineRunId] });
        queryClient.invalidateQueries({ queryKey: ['pipeline'] });
      } catch {
        // API error handled by interceptor
      }
    },
    [setStageApproval, queryClient],
  );

  // Reject flow removed — workflow is approve or re-run only.
  // Backend endpoint /pipeline/:id/reject/:stage preserved for API consumers.

  const handleStop = useCallback(() => {
    abort();
  }, [abort]);

  // ─── Hard Refresh — purge all caches, re-sync from API ────
  const handleHardRefresh = useCallback(async () => {
    // Preserve current stage position
    const currentStageIdx = usePipelineStore.getState().activeStageIndex;

    // 1. Clear ALL caches — localStorage + IndexedDB (await to ensure clean state)
    localStorage.removeItem('pipeline-storage');
    try {
      const { clearAllCache } = await import('@/lib/pipeline-cache');
      await clearAllCache();
    } catch { /* non-fatal */ }

    // 2. Reset pipeline store but restore stage position
    if (projectId && effectiveRunId) {
      initPipeline(projectId, effectiveRunId);
      setActiveStage(currentStageIdx);
    }

    // 3. Invalidate all React Query caches — triggers automatic refetch
    queryClient.invalidateQueries({ queryKey: ['pipeline'] });
    queryClient.invalidateQueries({ queryKey: ['pipeline-status'] });
    queryClient.invalidateQueries({ queryKey: ['all-stage-outputs'] });
    queryClient.invalidateQueries({ queryKey: ['stage-output'] });
    queryClient.invalidateQueries({ queryKey: ['stage-validation'] });
    queryClient.invalidateQueries({ queryKey: ['project'] });

    // 4. Visual feedback
    const el = document.createElement('div');
    el.textContent = 'Cache purged — data refreshed from server';
    el.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium shadow-lg animate-in fade-in slide-in-from-top-2 duration-300';
    document.body.appendChild(el);
    setTimeout(() => { el.classList.add('opacity-0', 'transition-opacity'); setTimeout(() => el.remove(), 300); }, 2500);
  }, [projectId, effectiveRunId, initPipeline, setActiveStage, queryClient]);

  // ─── Pipeline Shortcuts ─────────────────────────────────────
  usePipelineShortcuts({
    onExecute: () => { try { handleExecuteStage(); } catch { /* silent */ } },
    onStop: () => {/* abort handled elsewhere */},
    onNextStage: () => {
      if (activeStageIndex < stages.length - 1) setActiveStage(activeStageIndex + 1);
    },
    onPrevStage: () => {
      if (activeStageIndex > 0) setActiveStage(activeStageIndex - 1);
    },
    onToggleLogs: () => useUIPreferencesStore.getState().toggleBottomDock(),
    isExecuting,
  });

  // ─── Model + Prompt Override Handlers ─────────────────────

  const currentModel = useMemo(
    () =>
      (activeStage && stageModelOverrides[activeStage.name]) ||
      'claude-sonnet-4-20250514',
    [activeStage, stageModelOverrides],
  );

  const currentEvaluatorModel = useMemo(
    () =>
      (activeStage && stageEvaluatorModelOverrides[activeStage.name]) ||
      'claude-3-5-haiku-20241022',
    [activeStage, stageEvaluatorModelOverrides],
  );

  const currentComposerModel = useMemo(
    () =>
      (activeStage && stageComposerModelOverrides[activeStage.name]) ||
      '',
    [activeStage, stageComposerModelOverrides],
  );

  const handleModelChange = useCallback(
    (modelId: string) => {
      if (activeStage) setStageModelOverride(activeStage.name, modelId);
    },
    [activeStage, setStageModelOverride],
  );

  const handleComposerModelChange = useCallback(
    (modelId: string) => {
      if (activeStage) setStageComposerModelOverride(activeStage.name, modelId);
    },
    [activeStage, setStageComposerModelOverride],
  );

  const handleEvaluatorModelChange = useCallback(
    (modelId: string) => {
      if (activeStage) setStageEvaluatorModelOverride(activeStage.name, modelId);
    },
    [activeStage, setStageEvaluatorModelOverride],
  );

  const currentPrompt = useMemo(
    () => (activeStage && stagePromptOverrides[activeStage.name]) || '',
    [activeStage, stagePromptOverrides],
  );

  const handleSavePrompt = useCallback(
    (prompt: string) => {
      if (activeStage) setStagePromptOverride(activeStage.name, prompt);
    },
    [activeStage, setStagePromptOverride],
  );

  const handleResetPrompt = useCallback(() => {
    if (activeStage) clearStagePromptOverride(activeStage.name);
  }, [activeStage, clearStagePromptOverride]);

  const currentValidationPrompt = useMemo(
    () => (activeStage && stageValidationPromptOverrides[activeStage.name]) || '',
    [activeStage, stageValidationPromptOverrides],
  );

  const handleSaveValidationPrompt = useCallback(
    (prompt: string) => {
      if (activeStage) setStageValidationPromptOverride(activeStage.name, prompt);
    },
    [activeStage, setStageValidationPromptOverride],
  );

  const handleResetValidationPrompt = useCallback(() => {
    if (activeStage) clearStageValidationPromptOverride(activeStage.name);
  }, [activeStage, clearStageValidationPromptOverride]);

  // ─── Keyboard Shortcuts ───────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+K — Command Palette
      if (meta && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // Ctrl+Enter — Execute
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        try { handleExecuteStage(); } catch { /* error surfaced in scan panel */ }
        return;
      }

      // Cmd+B — Toggle left rail
      if (meta && e.key === 'b') {
        e.preventDefault();
        toggleLeftRail();
        return;
      }

      // Cmd+. — Toggle inspector
      if (meta && e.key === '.') {
        e.preventDefault();
        toggleRightPanel();
        return;
      }

      // Cmd+J — Toggle bottom dock
      if (meta && e.key === 'j') {
        e.preventDefault();
        toggleBottomDock();
        return;
      }

      // Cmd+Shift+P — Toggle prompt editor
      if (meta && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        togglePromptEditor();
        return;
      }

      // Ctrl+Shift+R — Hard refresh (purge cache, re-sync)
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        handleHardRefresh();
        return;
      }

      // Cmd+E — Export
      if (meta && e.key === 'e') {
        e.preventDefault();
        setExportDialogOpen(true);
        return;
      }

      // Alt+Right — Next stage
      if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        if (activeStageIndex < stages.length - 1) {
          setActiveStage(activeStageIndex + 1);
        }
        return;
      }

      // Alt+Left — Previous stage
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        if (activeStageIndex > 0) {
          setActiveStage(activeStageIndex - 1);
        }
        return;
      }

      // Cmd+1-8 — Jump to stage
      if (meta && e.key >= '1' && e.key <= '8') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < stages.length) setActiveStage(idx);
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    activeStageIndex,
    stages.length,
    handleExecuteStage,
    setActiveStage,
    setCommandPaletteOpen,
    setExportDialogOpen,
    toggleLeftRail,
    toggleRightPanel,
    toggleBottomDock,
    togglePromptEditor,
  ]);

  // ─── Command Palette Actions ──────────────────────────────

  const paletteActions = useMemo(
    () =>
      buildPaletteActions({
        onExecute: () => { try { handleExecuteStage(); } catch { /* silent */ } },
        onStop: handleStop,
        onAdvance: handleAdvance,
        onRerun: handleRerunStage,
        onHardRefresh: handleHardRefresh,
        onStageClick: setActiveStage,
        onToggleLeftRail: toggleLeftRail,
        onToggleRightPanel: toggleRightPanel,
        onToggleBottomDock: toggleBottomDock,
        onTogglePromptEditor: togglePromptEditor,
        onOpenExport: () => setExportDialogOpen(true),
        onOpenGitHub: () => setGithubSyncOpen(true),
        isGenerating: isExecuting,
        activeStageIndex,
      }),
    [
      handleExecuteStage,
      handleStop,
      handleAdvance,
      handleRerunStage,
      handleHardRefresh,
      setActiveStage,
      toggleLeftRail,
      toggleRightPanel,
      toggleBottomDock,
      togglePromptEditor,
      setExportDialogOpen,
      setGithubSyncOpen,
      isExecuting,
      activeStageIndex,
    ],
  );

  // ─── Loading State ────────────────────────────────────────

  if (!currentPipelineRunId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-600 border-t-transparent" />
      </div>
    );
  }

  // ─── Header ───────────────────────────────────────────────

  const headerContent = (
    <div className="flex items-center justify-between px-4 py-2 h-11">
      <div className="flex items-center gap-2 min-w-0">
        {/* Breadcrumbs */}
        <Link
          href="/projects"
          className="text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors hidden sm:inline"
        >
          Projects
        </Link>
        <ChevronRight className="w-3 h-3 text-slate-300 dark:text-slate-600 hidden sm:inline flex-shrink-0" />

        <Link
          href={`/projects/${projectId}`}
          className="text-[11px] text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors truncate max-w-[120px]"
        >
          {project?.name || 'Project'}
        </Link>
        <ChevronRight className="w-3 h-3 text-slate-300 dark:text-slate-600 flex-shrink-0" />

        <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
          Pipeline
        </h1>

        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 hidden md:inline px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded">
          run:{currentPipelineRunId?.slice(0, 8) ?? '—'}
        </span>

        {/* Global token counter */}
        <GlobalTokenCounter
          inputTokens={runUsage.inputTokens}
          outputTokens={runUsage.outputTokens}
          cost={runUsage.cost}
          className="hidden md:flex"
        />
      </div>

      <div className="flex items-center gap-1.5">
        {/* Toggle settings panel (left rail) */}
        <button
          onClick={toggleLeftRail}
          className={cn(
            'p-1.5 rounded-md transition-colors',
            leftRailCollapsed
              ? 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
              : 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-950/30',
          )}
          title="Toggle Settings Panel (Cmd+B)"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>

        {/* Toggle inspector panel (right panel) */}
        <button
          onClick={toggleRightPanel}
          className={cn(
            'p-1.5 rounded-md transition-colors',
            rightPanelCollapsed
              ? 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
              : 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-950/30',
          )}
          title="Toggle Inspector Panel"
        >
          <PanelRight className="w-3.5 h-3.5" />
        </button>

        {/* Command Palette trigger */}
        <button
          onClick={() => setCommandPaletteOpen(true)}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs',
            'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700',
            'transition-colors',
          )}
          title="Command Palette (Cmd+K)"
        >
          <Command className="w-3 h-3" />
          <kbd className="hidden sm:inline text-[9px] font-mono bg-slate-100 dark:bg-slate-700 px-1 rounded">
            K
          </kbd>
        </button>

        {/* Diagnostic Agent (SDK-experimental) */}
        <DiagnosticDialog pipelineRunId={currentPipelineRunId} />

        {/* Export */}
        <button
          onClick={() => setExportDialogOpen(true)}
          className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          title="Export (Cmd+E)"
        >
          <Download className="w-3.5 h-3.5" />
        </button>

        {/* GitHub */}
        <button
          onClick={() => setGithubSyncOpen(true)}
          className="p-1.5 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          title="GitHub Sync"
        >
          <GitBranch className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

  // ─── Render ───────────────────────────────────────────────

  return (
    <>
      <MissionControlLayout
        header={headerContent}
        leftRail={
          <LeftRail
            stages={stages}
            activeStageIndex={activeStageIndex}
            model={currentModel}
            onModelChange={handleModelChange}
            composerModel={currentComposerModel}
            onComposerModelChange={handleComposerModelChange}
            evaluatorModel={currentEvaluatorModel}
            onEvaluatorModelChange={handleEvaluatorModelChange}
            templateId={activeTemplateId ?? ''}
            onTemplateChange={setActiveTemplateId}
            deepAnalysis={deepAnalysis}
            onDeepAnalysisChange={setDeepAnalysis}
            skipLlmEval={skipLlmEval}
            onSkipLlmEvalChange={setSkipLlmEval}
            projectId={projectId}
            project={project}
          />
        }
        center={
          activeStage ? (
            <CenterPanel
              stage={activeStage}
              stageIndex={activeStageIndex}
              totalStages={stages.length}
              streamingText={streamingText}
              project={project}
              pipelineRunId={currentPipelineRunId}
              onExecute={handleExecuteStage}
              onStop={handleStop}
              onAdvance={() => { try { handleAdvance(); } catch { /* silent */ } }}
              onRerun={() => { try { handleRerunStage(); } catch { /* silent */ } }}
              onApprove={handleApprove}
              onReject={() => {}}
              isExecuting={isExecuting}
              currentPhase={currentPhase}
              promptEditorOpen={promptEditorOpen}
              onTogglePromptEditor={togglePromptEditor}
              currentPrompt={currentPrompt}
              onSavePrompt={handleSavePrompt}
              onResetPrompt={handleResetPrompt}
              validationPrompt={currentValidationPrompt}
              onSaveValidationPrompt={handleSaveValidationPrompt}
              onResetValidationPrompt={handleResetValidationPrompt}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400 text-sm">
              Select a stage to begin
            </div>
          )
        }
        inspector={
          activeStage ? (
            <InspectorPanel
              stage={activeStage}
              onApprove={handleApprove}
              onReject={() => {}}
              onRerun={handleRerunStage}
              userRole={userRole}
              pipelineRunId={currentPipelineRunId ?? undefined}
              confidenceThreshold={(project?.settings as any)?.confidenceThreshold}
              autoApprovalEnabled={(project?.settings as any)?.autoApprovalEnabled}
              autoApprovalTimeoutHours={(project?.settings as any)?.autoApprovalTimeoutHours}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400 text-sm">
              No stage selected
            </div>
          )
        }
        bottomDock={
          <BottomDock
            logs={logs}
            toolCalls={toolCalls}
            projectId={projectId}
            currentRunId={currentPipelineRunId}
          />
        }
      />

      {/* ─── Overlays ─────────────────────────────────────── */}
      <CommandPalette actions={paletteActions} />

      {exportDialogOpen && (
        <ExportDialog
          projectId={projectId}
          projectName={project?.name ?? 'project'}
          token={authToken}
          onClose={() => setExportDialogOpen(false)}
        />
      )}

      {githubSyncOpen && (
        <GitHubSyncDialog
          open={githubSyncOpen}
          files={usePipelineActivityStore
            .getState()
            .modernizedFiles.map((f: { path: string; content: string }) => ({ path: f.path, content: f.content }))}
        />
      )}

      <OnboardingOverlay />
    </>
  );
}
