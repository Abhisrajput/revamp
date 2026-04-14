'use client';

/**
 * Pipeline query hooks — re-exported from @revamp/core.
 *
 * The hooks now live in the shared package and use the injected API client.
 * This file exists for backward compatibility so existing imports
 * from '@/lib/hooks/use-pipeline-queries' continue to work.
 *
 * New code should import from '@revamp/core' directly.
 */

export {
  // Hooks
  useLatestPipelineRun,
  usePipelineStatus,
  useStageOutput,
  useAllStageOutputs,
  useStageValidation,
  useStageStatus,
  useApprovalGate,
  useCurrentSubtasks,
  useInvalidatePipeline,

  // Query keys
  pipelineKeys,
} from '@revamp/core';

export type {
  PipelineStatus,
  StageProgressEntry,
  ApprovalGate,
  SubtaskEntry,
  ValidationResult,
} from '@revamp/core';
