'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

import { usePipelineStore, canExecuteStage, getStageBlockReason } from '@/lib/stores/pipeline-store';
import { useUIPreferencesStore } from '@/lib/stores/ui-preferences-store';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useStageExecution } from '@/lib/hooks/use-stage-execution';
import { usePipelineShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { getCachedOutput, setCachedOutput, getCachedOutputsForRun } from '@/lib/pipeline-cache';

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

  // ─── Pipeline Store (granular selectors to avoid re-renders from streaming) ──
  const stages = usePipelineStore((s) => s.stages);
  const activeStageIndex = usePipelineStore((s) => s.activeStageIndex);
  const currentPipelineRunId = usePipelineStore((s) => s.currentPipelineRunId);
  const currentProjectId = usePipelineStore((s) => s.currentProjectId);
  const streamingText = usePipelineStore((s) => s.streamingText);
  const toolCalls = usePipelineStore((s) => s.toolCalls);
  const logs = usePipelineStore((s) => s.logs);
  const stageModelOverrides = usePipelineStore((s) => s.stageModelOverrides);
  const stageEvaluatorModelOverrides = usePipelineStore((s) => s.stageEvaluatorModelOverrides);
  const stagePromptOverrides = usePipelineStore((s) => s.stagePromptOverrides);
  const activeTemplateId = usePipelineStore((s) => s.activeTemplateId);
  const deepAnalysis = usePipelineStore((s) => s.deepAnalysis);
  const runUsage = usePipelineStore((s) => s.runUsage);

  // Actions (stable references — never trigger re-renders)
  const setActiveStage = usePipelineStore((s) => s.setActiveStage);
  const initPipeline = usePipelineStore((s) => s.initPipeline);
  const advanceToNextStage = usePipelineStore((s) => s.advanceToNextStage);
  const setStageApproval = usePipelineStore((s) => s.setStageApproval);
  const resetStage = usePipelineStore((s) => s.resetStage);
  const setStageModelOverride = usePipelineStore((s) => s.setStageModelOverride);
  const setStageEvaluatorModelOverride = usePipelineStore((s) => s.setStageEvaluatorModelOverride);
  const setStagePromptOverride = usePipelineStore((s) => s.setStagePromptOverride);
  const clearStagePromptOverride = usePipelineStore((s) => s.clearStagePromptOverride);
  const stageValidationPromptOverrides = usePipelineStore((s) => s.stageValidationPromptOverrides);
  const setStageValidationPromptOverride = usePipelineStore((s) => s.setStageValidationPromptOverride);
  const clearStageValidationPromptOverride = usePipelineStore((s) => s.clearStageValidationPromptOverride);
  const setActiveTemplateId = usePipelineStore((s) => s.setActiveTemplateId);
  const setDeepAnalysis = usePipelineStore((s) => s.setDeepAnalysis);

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
  } = useUIPreferencesStore();

  // ─── Stage Execution ──────────────────────────────────────
  const {
    executeStage,
    isExecuting,
    abort,
    currentPhase,
  } = useStageExecution();

  const activeStage = stages[activeStageIndex];
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
  const STAGE_INDEX_TO_NAME = ['SCAN', 'DECODE', 'BLUEPRINT', 'SPEC_LOCK', 'ARCHITECT', 'FORGE', 'SHADOW_RUN', 'EVOLVE'];

  useEffect(() => {
    if (!project) return;
    const store = usePipelineStore.getState();
    const stagePrompts = (project.stage_prompts || {}) as Record<string, string>;
    const validationPrompts = (project.validation_prompts || {}) as Record<string, string>;

    // Only seed if the store has no overrides yet (don't overwrite user edits)
    const hasExistingOverrides = Object.keys(store.stagePromptOverrides).length > 0;
    if (hasExistingOverrides) return;

    for (const [idx, prompt] of Object.entries(stagePrompts)) {
      const stageName = STAGE_INDEX_TO_NAME[parseInt(idx)];
      if (stageName && prompt) {
        store.setStagePromptOverride(stageName, prompt);
      }
    }
    for (const [idx, prompt] of Object.entries(validationPrompts)) {
      const stageName = STAGE_INDEX_TO_NAME[parseInt(idx)];
      if (stageName && prompt) {
        store.setStageValidationPromptOverride(stageName, prompt);
      }
    }
  }, [project]);

  // ─── Sync stage statuses from backend ─────────────────────
  const syncStagesFromBackend = async (runId: string) => {
    try {
      const res = await apiClient.get(`/pipeline/${runId}/status`);
      const runStatus = res.data?.status;
      if (runStatus === 'failed' || runStatus === 'cancelled') {
        return false; // caller should create a new run
      }

      // Sync ALL stage statuses from DB — authoritative source of truth
      const stageProgress = res.data?.stage_progress;
      if (stageProgress) {
        const s = usePipelineStore.getState();
        for (let i = 0; i < s.stages.length; i++) {
          const storeStage = s.stages[i];
          const dbStatus = stageProgress[storeStage.name]?.status;
          if (dbStatus && dbStatus !== storeStage.status) {
            console.warn(
              `[Rehydrate] Stage ${storeStage.name} "${storeStage.status}" → "${dbStatus}"`,
            );
            usePipelineStore.getState().setStageStatus(i, dbStatus as any);
          }
          // Sync approval status from stage progress
          if (dbStatus === 'approved' && storeStage.approvalStatus !== 'approved') {
            usePipelineStore.getState().setStageApproval(i, 'approved');
          }
          if (dbStatus === 'awaiting_approval' && storeStage.approvalStatus !== 'pending') {
            usePipelineStore.getState().setStageStatus(i, 'completed' as any);
            usePipelineStore.getState().setStageApproval(i, 'pending');
          }
        }
      }

      // Sync approval gates
      const approvalGates = res.data?.approval_gates;
      if (approvalGates) {
        const s = usePipelineStore.getState();
        for (const gate of approvalGates) {
          const stageIdx = s.stages.findIndex((st) => st.name === gate.stage_name);
          if (stageIdx >= 0) {
            const currentApproval = s.stages[stageIdx].approvalStatus;
            if (gate.status !== currentApproval) {
              usePipelineStore.getState().setStageApproval(stageIdx, gate.status as any);
            }
          }
        }
      }

      // Load stage outputs — IndexedDB first, then API fallback
      const updatedStore = usePipelineStore.getState();
      const stagesToLoad = updatedStore.stages
        .filter((st) => (st.status === 'completed' || st.status === 'approved') && !st.output)
        .map((st) => st.name);

      if (stagesToLoad.length > 0) {
        // Try IndexedDB cache first (instant, no network)
        const cached = await getCachedOutputsForRun(runId);
        for (const stageName of stagesToLoad) {
          const idx = updatedStore.stages.findIndex((st) => st.name === stageName);
          if (idx < 0) continue;

          if (cached[stageName]) {
            // Cache hit — instant load
            usePipelineStore.getState().setStageOutput(idx, cached[stageName]);
            console.log(`[Cache HIT] ${stageName}: ${cached[stageName].length} chars from IndexedDB`);
          } else {
            // Cache miss — fetch from API and store in IndexedDB
            try {
              const artRes = await apiClient.get(`/pipeline/${runId}/artifacts/${stageName}`);
              const rawData = artRes.data;
              const artifacts = Array.isArray(rawData) ? rawData : rawData?.artifacts || rawData?.data || [];
              const outputArt = artifacts.find((a: any) => a.artifact_type === 'stage_output');
              const content = outputArt?.metadata?.content || outputArt?.metadata?.output;
              if (content) {
                usePipelineStore.getState().setStageOutput(idx, content);
                // Cache in IndexedDB for next visit
                setCachedOutput(runId, stageName, content);
                console.log(`[Cache MISS] ${stageName}: ${content.length} chars fetched → IndexedDB`);
              }
            } catch {
              // Non-fatal
            }
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  };

  // ─── Create pipeline run if needed ────────────────────────
  const startPipeline = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post('/pipeline/start', {
        project_id: projectId,
      });
      return res.data as { pipeline_run_id: string };
    },
    onSuccess: async (data) => {
      initPipeline(projectId, data.pipeline_run_id);
      // Immediately sync stages from backend (the run may already have progress)
      await syncStagesFromBackend(data.pipeline_run_id);
    },
    onError: () => {
      if (!usePipelineStore.getState().currentPipelineRunId) {
        initPipeline(projectId, `local-${crypto.randomUUID()}`);
      }
    },
  });

  // Wait for Zustand hydration before init — on SSR first render,
  // currentProjectId/currentPipelineRunId are null (defaults), not the
  // persisted values. Without this guard, every refresh calls initPipeline
  // which resets activeStageIndex to 0.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // Zustand persist hydrates synchronously after first render
    const unsub = usePipelineStore.persist.onFinishHydration(() => setHydrated(true));
    // If already hydrated (hot reload), set immediately
    if (usePipelineStore.persist.hasHydrated()) setHydrated(true);
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!projectId || !hydrated) return;

    // If a specific run ID is provided via URL (?run=xxx), use it directly
    if (runIdFromUrl) {
      if (currentPipelineRunId !== runIdFromUrl) {
        initPipeline(projectId, runIdFromUrl);
      }
      syncStagesFromBackend(runIdFromUrl).then((ok) => {
        if (!ok) startPipeline.mutate();
      });
      return;
    }

    // Always reinitialize when switching to a different project
    if (currentProjectId !== projectId) {
      startPipeline.mutate();
      return;
    }
    if (!currentPipelineRunId) {
      startPipeline.mutate();
      return;
    }
    // Verify the persisted pipeline run still exists and sync stages
    syncStagesFromBackend(currentPipelineRunId).then((ok) => {
      if (!ok) startPipeline.mutate();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, runIdFromUrl, hydrated]);

  // ─── Poll for stuck stages (SSE drop recovery) ─────────────
  // If a stage is stuck in 'generating' for 30+ seconds, poll DB to check if it
  // actually completed. This handles SSE drops and browser tab suspensions.
  useEffect(() => {
    if (!currentPipelineRunId) return;
    const interval = setInterval(() => {
      const s = usePipelineStore.getState();
      const hasStuck = s.stages.some(
        (st) => st.status === 'generating' || st.status === 'validating',
      );
      if (!hasStuck) return;
      apiClient
        .get(`/pipeline/${currentPipelineRunId}/status`)
        .then((res) => {
          const stageProgress = res.data?.stage_progress;
          if (!stageProgress) return;
          const s2 = usePipelineStore.getState();
          for (let i = 0; i < s2.stages.length; i++) {
            const storeStage = s2.stages[i];
            const dbStatus = stageProgress[storeStage.name]?.status;
            if (
              dbStatus &&
              (storeStage.status === 'generating' || storeStage.status === 'validating') &&
              (dbStatus === 'completed' || dbStatus === 'approved' || dbStatus === 'failed')
            ) {
              usePipelineStore.getState().setStageStatus(i, dbStatus as any);
            }
          }
        })
        .catch(() => { /* silent — will retry on next interval */ });
    }, 30_000);
    return () => clearInterval(interval);
  }, [currentPipelineRunId]);

  // ─── Refetch project data when SCAN completes (picks up folder_structure) ──
  const scanStatus = stages[0]?.status;
  useEffect(() => {
    if (scanStatus === 'completed' || scanStatus === 'approved') {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    }
  }, [scanStatus, projectId, queryClient]);

  // ─── Rehydrate stage outputs from API after page refresh ──────
  // The pipeline store strips outputs on persist (too large for localStorage).
  // On mount + when active stage changes, fetch outputs from stage_artifacts.
  useEffect(() => {
    if (!currentPipelineRunId) return;
    const s = usePipelineStore.getState();
    const completedWithoutOutput = s.stages
      .filter((st) => (st.status === 'completed' || st.status === 'approved' || st.status === 'failed') && !st.output);
    if (completedWithoutOutput.length === 0) return;

    // Fetch per-stage artifacts directly (skip list endpoint)
    const stageNames = completedWithoutOutput.map((st) => st.name);
    (async () => {
      for (const stageName of stageNames) {
        try {
          const stageRes = await apiClient.get(
            `/pipeline/${currentPipelineRunId}/artifacts/${stageName}`,
          );
          const rawData = stageRes.data;
          const artifacts = Array.isArray(rawData) ? rawData : rawData?.artifacts || rawData?.data || [];
          const outputArtifact = artifacts.find((a: any) => a.artifact_type === 'stage_output');
          const outputContent = outputArtifact?.metadata?.content || outputArtifact?.metadata?.output;
          if (outputContent) {
            const stageIndex = s.stages.findIndex((st) => st.name === stageName);
            if (stageIndex >= 0) {
              usePipelineStore.getState().setStageOutput(stageIndex, outputContent);
            }
          }
          // Rehydrate validation — prefer the separate validation_result artifact
          // which has full criteria, over the stage_output metadata which only
          // has { passed, confidenceScore, issueCount } (no criteria/issues).
          const stageIndex2 = s.stages.findIndex((st) => st.name === stageName);
          if (stageIndex2 >= 0) {
            const validationArtifact = artifacts.find((a: any) => a.artifact_type === 'validation_result');
            if (validationArtifact?.metadata) {
              const v = validationArtifact.metadata;
              const criteria: Array<{ name: string; passed: boolean; score: number; feedback: string }> = [];

              // Map deterministic check results
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

              // Map LLM evaluation results
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

              // Fallback to issues array
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

              usePipelineStore.getState().setStageValidation(stageIndex2, {
                passed: v.passed ?? false,
                score: v.confidenceScore ?? 0,
                criteria,
                summary: Array.isArray(v.recommendations) ? v.recommendations.slice(0, 3).join('; ') : '',
                validatedAt: validationArtifact.created_at ?? new Date().toISOString(),
              });
            } else {
              // Fallback: use basic validation from stage_output metadata
              const stageOutputMeta = outputArtifact?.metadata;
              if (stageOutputMeta?.validation && stageOutputMeta.validation.passed !== undefined) {
                const v = stageOutputMeta.validation;
                usePipelineStore.getState().setStageValidation(stageIndex2, {
                  passed: v.passed ?? false,
                  score: v.confidenceScore ?? 0,
                  criteria: [],
                  summary: '',
                  validatedAt: new Date().toISOString(),
                });
              }
            }
          }

          // Rehydrate artifacts into the store for the Artifacts tab
          const stageIndex = s.stages.findIndex((st) => st.name === stageName);
          if (stageIndex >= 0) {
            const store = usePipelineStore.getState();
            const existing = store.stages[stageIndex].artifacts;
            for (const a of artifacts) {
              if (existing.some((e) => e.id === a.id)) continue; // skip duplicates
              store.addStageArtifact(stageIndex, {
                id: a.id,
                name: a.artifact_type,
                type: a.artifact_type,
                url: a.storage_path ?? '',
                size: a.file_size ?? 0,
                createdAt: a.created_at ?? new Date().toISOString(),
              });
            }
          }
        } catch (err: any) {
          console.error('[Rehydrate] Failed for', stageName, err?.message);
        }
      }
    })();
  }, [currentPipelineRunId, activeStageIndex]);

  // Left rail stays open — stages moved to main sidebar, but settings/cost/docs remain here

  // ─── LLM Config State ───────────────────────────────────
  const [skipLlmEval, setSkipLlmEval] = useState(false);

  // ─── Handlers ─────────────────────────────────────────────

  const handleExecuteStage = useCallback(() => {
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
    // Reset completed/failed stages before re-executing to clear stale output
    if (stage.status === 'completed' || stage.status === 'failed') {
      resetStage(s.activeStageIndex);
    }
    executeStage(s.currentPipelineRunId, stage.name, { skipLlmEval });
  }, [executeStage, skipLlmEval, resetStage]);

  const handleRerunStage = useCallback(() => {
    const s = usePipelineStore.getState();
    const stage = s.stages[s.activeStageIndex];
    if (!s.currentPipelineRunId || !stage) return;
    // Guardrail: check prerequisites before re-run (prior stages must still be complete)
    if (s.activeStageIndex > 0) {
      for (let i = 0; i < s.activeStageIndex; i++) {
        const prior = s.stages[i];
        if (prior.status !== 'completed' && prior.status !== 'approved') return;
      }
    }
    resetStage(s.activeStageIndex);
    executeStage(s.currentPipelineRunId, stage.name, { skipLlmEval });
  }, [resetStage, executeStage, skipLlmEval]);

  const handleAdvance = useCallback(() => {
    advanceToNextStage();
  }, [advanceToNextStage]);

  const handleApprove = useCallback(
    async (comment?: string) => {
      const s = usePipelineStore.getState();
      const stage = s.stages[s.activeStageIndex];
      if (!s.currentPipelineRunId || !stage) return;
      // Guard: only allow approval after stage has been executed
      if (stage.status !== 'completed' || stage.approvalStatus !== 'pending') return;
      try {
        await apiClient.post(
          `/pipeline/${s.currentPipelineRunId}/approve/${stage.name}`,
          { comment },
        );
        setStageApproval(s.activeStageIndex, 'approved');
      } catch {
        // API error handled by interceptor
      }
    },
    [setStageApproval],
  );

  const handleReject = useCallback(
    async (reason: string) => {
      const s = usePipelineStore.getState();
      const stage = s.stages[s.activeStageIndex];
      if (!s.currentPipelineRunId || !stage) return;
      try {
        await apiClient.post(
          `/pipeline/${s.currentPipelineRunId}/reject/${stage.name}`,
          { reason },
        );
        setStageApproval(s.activeStageIndex, 'rejected');
      } catch {
        // API error handled by interceptor
      }
    },
    [setStageApproval],
  );

  const handleStop = useCallback(() => {
    abort();
  }, [abort]);

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

  const handleModelChange = useCallback(
    (modelId: string) => {
      if (activeStage) setStageModelOverride(activeStage.name, modelId);
    },
    [activeStage, setStageModelOverride],
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

  if (!currentPipelineRunId && startPipeline.isPending) {
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
            evaluatorModel={currentEvaluatorModel}
            onEvaluatorModelChange={handleEvaluatorModelChange}
            templateId={activeTemplateId}
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
              onReject={handleReject}
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
              onReject={handleReject}
              userRole={userRole}
              pipelineRunId={currentPipelineRunId ?? undefined}
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
          files={usePipelineStore
            .getState()
            .modernizedFiles.map((f) => ({ path: f.path, content: f.content }))}
        />
      )}

      <OnboardingOverlay />
    </>
  );
}
