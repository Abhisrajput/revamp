'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

// ─── Types ──────────────────────────────────────────────────────

interface StageProgress {
  status: string;
  progress?: number;
  confidenceScore?: number;
}

interface PipelineStatus {
  id: string;
  status: string;
  current_stage: string;
  stage_progress: Record<string, StageProgress>;
  approval_gates?: any[];
}

// ─── Hooks ──────────────────────────────────────────────────────

/**
 * Fetch or create the latest pipeline run for a project.
 * Returns the run ID.
 */
export function useLatestPipelineRun(projectId: string | null) {
  return useQuery<string | null>({
    queryKey: ['pipeline-run', projectId],
    queryFn: async () => {
      if (!projectId) return null;
      const res = await apiClient.post('/pipeline/start', { project_id: projectId });
      return res.data?.pipeline_run_id ?? null;
    },
    enabled: !!projectId,
    staleTime: Infinity, // run ID doesn't change
    retry: 1,
  });
}

/**
 * Fetch pipeline run status (stage progress, approval gates).
 */
export function usePipelineStatus(runId: string | null) {
  return useQuery<PipelineStatus | null>({
    queryKey: ['pipeline-status', runId],
    queryFn: async () => {
      if (!runId) return null;
      const res = await apiClient.get(`/pipeline/${runId}/status`);
      return res.data;
    },
    enabled: !!runId,
    staleTime: 10_000,
    // Adaptive polling: 5s while running, 30s when idle/completed
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'running' || status === 'pending') return 5_000;
      if (status === 'completed' || status === 'failed' || status === 'cancelled') return 30_000;
      return 10_000;
    },
  });
}

/**
 * Fetch a single stage's output content.
 * Returns the markdown string or null.
 */
export function useStageOutput(runId: string | null, stageName: string | null) {
  return useQuery<string | null>({
    queryKey: ['stage-output', runId, stageName],
    queryFn: async () => {
      if (!runId || !stageName) return null;
      const res = await apiClient.get(`/pipeline/${runId}/artifacts/${stageName}`);
      const arts = Array.isArray(res.data) ? res.data : [];
      const outputArt = arts.find((a: any) => a.artifact_type === 'stage_output');
      return outputArt?.metadata?.content || outputArt?.metadata?.output || null;
    },
    enabled: !!runId && !!stageName,
    staleTime: 60_000, // outputs are immutable once written
    retry: false, // 404 is normal for pending stages
  });
}

/**
 * Fetch validation results for a stage.
 */
export function useStageValidation(runId: string | null, stageName: string | null) {
  return useQuery<any>({
    queryKey: ['validation', runId, stageName],
    queryFn: async () => {
      if (!runId || !stageName) return null;
      const res = await apiClient.get(`/pipeline/${runId}/validation/${stageName}`);
      return res.data;
    },
    enabled: !!runId && !!stageName,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Fetch all artifacts for a stage.
 */
export function useStageArtifacts(runId: string | null, stageName: string | null) {
  return useQuery<any[]>({
    queryKey: ['stage-artifacts', runId, stageName],
    queryFn: async () => {
      if (!runId || !stageName) return [];
      const res = await apiClient.get(`/pipeline/${runId}/artifacts/${stageName}`);
      return Array.isArray(res.data) ? res.data : [];
    },
    enabled: !!runId && !!stageName,
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * Batch-fetch all stage outputs for a pipeline run.
 * Used on initial page load to populate everything at once.
 */
export function useAllStageOutputs(runId: string | null, stageNames: string[]) {
  return useQuery<Record<string, string | null>>({
    queryKey: ['all-stage-outputs', runId],
    queryFn: async () => {
      if (!runId) return {};
      const results: Record<string, string | null> = {};

      // Fetch status first to know which stages have outputs
      const statusRes = await apiClient.get(`/pipeline/${runId}/status`);
      const sp = statusRes.data?.stage_progress || {};

      // Only fetch artifacts for stages that are not pending/in_progress
      const stagesToFetch = stageNames.filter(name => {
        const status = sp[name]?.status;
        return status && status !== 'pending' && status !== 'in_progress';
      });

      // Fetch all in parallel
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
 * Helper: set stage output in React Query cache (called from SSE handler)
 */
export function setStageOutputInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  runId: string,
  stageName: string,
  output: string,
) {
  queryClient.setQueryData(['stage-output', runId, stageName], output);
  // Also update the batch cache
  queryClient.setQueryData<Record<string, string | null>>(
    ['all-stage-outputs', runId],
    (old) => ({ ...old, [stageName]: output }),
  );
}

/**
 * Helper: set validation in React Query cache (called from SSE handler)
 */
export function setValidationInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  runId: string,
  stageName: string,
  validation: any,
) {
  queryClient.setQueryData(['validation', runId, stageName], validation);
}
