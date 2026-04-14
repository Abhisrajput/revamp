// @revamp/core — Frontend business logic package
//
// Boundary rules:
//   ✓ React hooks, @tanstack/react-query, zustand, @revamp/shared-types
//   ✗ next/*, react-dom, localStorage, window, process.env

// API
export { setApiClient, getApiClient } from './api/types';
export type { ApiClient, ApiResponse, RequestConfig } from './api/types';

// Storage
export { setSessionStorage, setPersistStorage, getSessionStorage, getPersistStorage } from './api/storage';
export type { StorageAdapter } from './api/storage';

// Query Keys
export { pipelineKeys, projectKeys, agentKeys } from './hooks/pipeline-keys';

// Pipeline Hooks (platform-independent — uses injected API client)
export {
  useLatestPipelineRun,
  usePipelineStatus,
  useStageOutput,
  useAllStageOutputs,
  useStageValidation,
  useStageStatus,
  useApprovalGate,
  useCurrentSubtasks,
  useInvalidatePipeline,
} from './hooks/use-pipeline-queries';

// Agent Hooks (all exports)
export * from './hooks/use-agents';

// Orchestrator Hook (all exports)
export * from './hooks/use-orchestrator';

// Refine Section Hook
export { useRefineSection } from './hooks/use-refine-section';

// Stores (platform-independent — uses injected storage adapters)
export { usePipelineActivityStore } from './stores/pipeline-activity-store';

// Pipeline API Types
export type {
  PipelineStatus,
  StageProgressEntry,
  ApprovalGate,
  SubtaskEntry,
  ValidationResult,
} from './types/pipeline';

// Stage Types, Constants & Helpers
export {
  STAGE_NAMES,
  STAGE_LABELS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  stageRequiresApproval,
  createDefaultStage,
  createDefaultStages,
  canExecuteStage,
  shouldShowApprovalGate,
  getStageBlockReason,
} from './types/stage';

export type {
  StageName,
  StageStatus,
  ApprovalStatus,
  StageArtifact,
  StageValidation,
  ValidationDimensionScore,
  ValidationFinding,
  ApprovalHistoryEntry,
  ScanSubtaskState,
  StageState,
  RunUsage,
  UsageByModel,
  UsageByStage,
  ModernizedFile,
  FeatureFile,
} from './types/stage';
