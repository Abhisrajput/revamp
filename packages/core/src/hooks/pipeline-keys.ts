/**
 * Pipeline React Query key factories.
 *
 * Hierarchical keys enable targeted invalidation:
 *   invalidate ['pipeline-status', runId] → refetches status
 *   invalidate ['stage-output', runId, 'SCAN'] → refetches one output
 *   invalidate ['stage-output', runId] → refetches all outputs
 *
 * Shared across apps — no platform dependencies.
 */

export const pipelineKeys = {
  run: (projectId: string) => ['pipeline-run', projectId] as const,
  status: (runId: string) => ['pipeline-status', runId] as const,
  outputs: (runId: string) => ['stage-outputs', runId] as const,
  output: (runId: string, stage: string) => ['stage-output', runId, stage] as const,
  validation: (runId: string, stage: string) => ['stage-validation', runId, stage] as const,
  allValidations: (runId: string) => ['stage-validations', runId] as const,
};

export const projectKeys = {
  detail: (projectId: string) => ['project', projectId] as const,
  list: () => ['projects'] as const,
};

export const agentKeys = {
  list: () => ['agents'] as const,
  detail: (agentId: string) => ['agent', agentId] as const,
  orchestrator: () => ['agent-orchestrator'] as const,
};
