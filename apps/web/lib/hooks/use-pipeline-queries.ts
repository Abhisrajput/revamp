'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { StageValidation, ScanSubtaskState } from '@/lib/stores/pipeline-types';

// ─── Types ──────────────────────────────────────────────────────

/** Backend stage_progress entry */
export interface StageProgressEntry {
  status: string;
  progress?: number;
  confidenceScore?: number;
  startedAt?: string;
  updatedAt?: string;
}

/** Backend approval gate */
export interface ApprovalGate {
  id: string;
  stage_name: string;
  status: string;
  required_role: string;
  approved_by?: string;
  approval_comment?: string;
  approved_at?: string;
}

/** Subtask from the backend */
export interface SubtaskEntry {
  id: string;
  title: string;
  priority?: string;
  status: string;
  cost_cents?: number;
  type?: string;
  agent_name?: string;
  duration_ms?: number;
  error?: string;
}

/** Full pipeline status from GET /pipeline/:id/status */
export interface PipelineStatus {
  id: string;
  status: string;
  current_stage: string;
  stage_progress: Record<string, StageProgressEntry>;
  current_stage_subtasks?: SubtaskEntry[];
  current_stage_progress?: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    rounds: number;
  };
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  artifacts?: Array<{ id: string; stage_name: string; artifact_type: string; created_at: string }>;
  approval_gates?: ApprovalGate[];
}

/** Parsed validation result from artifact metadata */
export interface ValidationResult {
  passed: boolean;
  confidenceScore: number;
  deterministicResults: Array<{
    name: string;
    status: string;
    score: number;
    message: string;
    weight?: number;
  }>;
  llmResults: Array<{
    dimension: string;
    score: number;
    weight: number;
    reasoning: string;
  }>;
  issues: Array<{
    id: string;
    code: string;
    severity: string;
    title: string;
    description: string;
  }>;
  recommendations: string[];
  contractViolations: Array<{
    type: string;
    severity: string;
    description: string;
    section?: string;
  }>;
}

// ─── Query Key Factories ────────────────────────────────────────
// Hierarchical keys enable targeted invalidation:
//   invalidate ['pipeline-status', runId] → refetches status
//   invalidate ['stage-output', runId, 'SCAN'] → refetches one output
//   invalidate ['stage-output', runId] → refetches all outputs

export const pipelineKeys = {
  run: (projectId: string) => ['pipeline-run', projectId] as const,
  status: (runId: string) => ['pipeline-status', runId] as const,
  outputs: (runId: string) => ['stage-outputs', runId] as const,
  output: (runId: string, stage: string) => ['stage-output', runId, stage] as const,
  validation: (runId: string, stage: string) => ['stage-validation', runId, stage] as const,
  allValidations: (runId: string) => ['stage-validations', runId] as const,
};

// ─── Hooks ──────────────────────────────────────────────────────

/**
 * Fetch or create the latest pipeline run for a project.
 * Returns the run ID.
 */
export function useLatestPipelineRun(projectId: string | null) {
  return useQuery<string | null>({
    queryKey: pipelineKeys.run(projectId || ''),
    queryFn: async () => {
      if (!projectId) return null;
      const res = await apiClient.post('/pipeline/start', { project_id: projectId });
      return res.data?.pipeline_run_id ?? null;
    },
    enabled: !!projectId,
    staleTime: Infinity,
    retry: 1,
  });
}

/**
 * Fetch pipeline run status (stage progress, approval gates, subtasks).
 * This is the PRIMARY source of truth for all stage states.
 */
export function usePipelineStatus(runId: string | null) {
  return useQuery<PipelineStatus | null>({
    queryKey: pipelineKeys.status(runId || ''),
    queryFn: async () => {
      if (!runId) return null;
      const res = await apiClient.get(`/pipeline/${runId}/status`);
      return res.data;
    },
    enabled: !!runId,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'running' || status === 'pending') return 5_000;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return 30_000;
      return 10_000;
    },
  });
}

/**
 * Fetch a single stage output. Cached per stage.
 */
export function useStageOutput(runId: string | null, stageName: string | null) {
  return useQuery<string | null>({
    queryKey: pipelineKeys.output(runId || '', stageName || ''),
    queryFn: async () => {
      if (!runId || !stageName) return null;
      const res = await apiClient.get(`/pipeline/${runId}/artifacts/${stageName}`);
      const arts = Array.isArray(res.data) ? res.data : [];
      const outputArt = arts.find((a: any) => a.artifact_type === 'stage_output');
      return outputArt?.metadata?.content || outputArt?.metadata?.output || null;
    },
    enabled: !!runId && !!stageName,
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * Batch-fetch all stage outputs for a pipeline run.
 */
export function useAllStageOutputs(runId: string | null, stageNames: string[]) {
  return useQuery<Record<string, string | null>>({
    queryKey: pipelineKeys.outputs(runId || ''),
    queryFn: async () => {
      if (!runId) return {};
      const results: Record<string, string | null> = {};

      const statusRes = await apiClient.get(`/pipeline/${runId}/status`);
      const sp = statusRes.data?.stage_progress || {};

      const stagesToFetch = stageNames.filter(name => {
        const status = sp[name]?.status;
        return status && status !== 'pending' && status !== 'in_progress';
      });

      const fetches = stagesToFetch.map(async (name) => {
        try {
          const res = await apiClient.get(`/pipeline/${runId}/artifacts/${name}`);
          const arts = Array.isArray(res.data) ? res.data : [];
          const outputArt = arts.find((a: any) => a.artifact_type === 'stage_output');
          results[name] = outputArt?.metadata?.content || outputArt?.metadata?.output || null;
        } catch {
          results[name] = null;
        }
      });

      await Promise.all(fetches);
      return results;
    },
    enabled: !!runId,
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * Fetch validation result for a specific stage.
 */
export function useStageValidation(runId: string | null, stageName: string | null) {
  return useQuery<ValidationResult | null>({
    queryKey: pipelineKeys.validation(runId || '', stageName || ''),
    queryFn: async () => {
      if (!runId || !stageName) return null;
      try {
        const res = await apiClient.get(`/pipeline/${runId}/artifacts/${stageName}`);
        const arts = Array.isArray(res.data) ? res.data : [];
        const valArt = arts.find((a: any) => a.artifact_type === 'validation_result');
        if (!valArt?.metadata) return null;
        return valArt.metadata as ValidationResult;
      } catch {
        return null;
      }
    },
    enabled: !!runId && !!stageName,
    staleTime: 60_000,
    retry: 1,
  });
}

// ─── Derived selectors (compute from React Query cache) ─────────

/**
 * Get the status for a specific stage from the pipeline status cache.
 * Use this instead of reading from Zustand.
 */
export function useStageStatus(runId: string | null, stageName: string) {
  const { data: status } = usePipelineStatus(runId);
  if (!status) return null;
  return status.stage_progress?.[stageName] ?? null;
}

/**
 * Get approval gate for a specific stage.
 */
export function useApprovalGate(runId: string | null, stageName: string) {
  const { data: status } = usePipelineStatus(runId);
  if (!status?.approval_gates) return null;
  return status.approval_gates.find(g => g.stage_name === stageName) ?? null;
}

/**
 * Get subtasks for the current stage.
 */
export function useCurrentSubtasks(runId: string | null) {
  const { data: status } = usePipelineStatus(runId);
  return {
    subtasks: status?.current_stage_subtasks ?? [],
    progress: status?.current_stage_progress ?? null,
  };
}

/**
 * Helper to invalidate pipeline data after mutations (approve, execute, etc.)
 */
export function useInvalidatePipeline() {
  const queryClient = useQueryClient();
  return {
    invalidateStatus: (runId: string) =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.status(runId) }),
    invalidateOutput: (runId: string, stage: string) =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.output(runId, stage) }),
    invalidateAllOutputs: (runId: string) =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.outputs(runId) }),
    invalidateValidation: (runId: string, stage: string) =>
      queryClient.invalidateQueries({ queryKey: pipelineKeys.validation(runId, stage) }),
    invalidateAll: (runId: string) => {
      queryClient.invalidateQueries({ queryKey: pipelineKeys.status(runId) });
      queryClient.invalidateQueries({ queryKey: pipelineKeys.outputs(runId) });
      queryClient.invalidateQueries({ queryKey: ['stage-output', runId] });
      queryClient.invalidateQueries({ queryKey: ['stage-validation', runId] });
    },
  };
}
