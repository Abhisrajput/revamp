/**
 * Pipeline React Query hooks — platform-independent.
 *
 * Uses getApiClient() from the injection pattern instead of importing
 * a concrete axios client. The app registers the client at boot via setApiClient().
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '../api/types';
import { pipelineKeys } from './pipeline-keys';
import type { PipelineStatus, ValidationResult } from '../types/pipeline';

// ─── Hooks ──────────────────────────────────────────────────────

export function useLatestPipelineRun(projectId: string | null) {
  const api = getApiClient();
  return useQuery<string | null>({
    queryKey: pipelineKeys.run(projectId || ''),
    queryFn: async () => {
      if (!projectId) return null;
      const res = await api.post('/pipeline/start', { project_id: projectId });
      return res.data?.pipeline_run_id ?? null;
    },
    enabled: !!projectId,
    staleTime: Infinity,
    retry: 1,
  });
}

export function usePipelineStatus(runId: string | null) {
  const api = getApiClient();
  return useQuery<PipelineStatus | null>({
    queryKey: pipelineKeys.status(runId || ''),
    queryFn: async () => {
      if (!runId) return null;
      const res = await api.get(`/pipeline/${runId}/status`);
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

export function useStageOutput(runId: string | null, stageName: string | null) {
  const api = getApiClient();
  return useQuery<string | null>({
    queryKey: pipelineKeys.output(runId || '', stageName || ''),
    queryFn: async () => {
      if (!runId || !stageName) return null;
      const res = await api.get(`/pipeline/${runId}/artifacts/${stageName}`);
      const arts = Array.isArray(res.data) ? res.data : [];
      const outputArt = arts.find((a: any) => a.artifact_type === 'stage_output');
      return outputArt?.metadata?.content || outputArt?.metadata?.output || null;
    },
    enabled: !!runId && !!stageName,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useAllStageOutputs(runId: string | null, stageNames: string[]) {
  const api = getApiClient();
  return useQuery<Record<string, string | null>>({
    queryKey: pipelineKeys.outputs(runId || ''),
    queryFn: async () => {
      if (!runId) return {};
      const results: Record<string, string | null> = {};
      const statusRes = await api.get(`/pipeline/${runId}/status`);
      const sp = statusRes.data?.stage_progress || {};
      const stagesToFetch = stageNames.filter(name => {
        const status = sp[name]?.status;
        return status && status !== 'pending' && status !== 'in_progress';
      });
      const fetches = stagesToFetch.map(async (name) => {
        try {
          const res = await api.get(`/pipeline/${runId}/artifacts/${name}`);
          const arts = Array.isArray(res.data) ? res.data : [];
          const outputArt = arts.find((a: any) => a.artifact_type === 'stage_output');
          results[name] = outputArt?.metadata?.content || outputArt?.metadata?.output || null;
        } catch { results[name] = null; }
      });
      await Promise.all(fetches);
      return results;
    },
    enabled: !!runId,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useStageValidation(runId: string | null, stageName: string | null) {
  const api = getApiClient();
  return useQuery<ValidationResult | null>({
    queryKey: pipelineKeys.validation(runId || '', stageName || ''),
    queryFn: async () => {
      if (!runId || !stageName) return null;
      try {
        const res = await api.get(`/pipeline/${runId}/artifacts/${stageName}`);
        const arts = Array.isArray(res.data) ? res.data : [];
        const valArt = arts.find((a: any) => a.artifact_type === 'validation_result');
        if (!valArt?.metadata) return null;
        return valArt.metadata as ValidationResult;
      } catch { return null; }
    },
    enabled: !!runId && !!stageName,
    staleTime: 60_000,
    retry: 1,
  });
}

// ─── Derived selectors ──────────────────────────────────────────

export function useStageStatus(runId: string | null, stageName: string) {
  const { data: status } = usePipelineStatus(runId);
  if (!status) return null;
  return status.stage_progress?.[stageName] ?? null;
}

export function useApprovalGate(runId: string | null, stageName: string) {
  const { data: status } = usePipelineStatus(runId);
  if (!status?.approval_gates) return null;
  return status.approval_gates.find((g: any) => g.stage_name === stageName) ?? null;
}

export function useCurrentSubtasks(runId: string | null) {
  const { data: status } = usePipelineStatus(runId);
  return {
    subtasks: status?.current_stage_subtasks ?? [],
    progress: status?.current_stage_progress ?? null,
  };
}

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
