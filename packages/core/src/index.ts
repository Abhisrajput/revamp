// @revamp/core — Frontend business logic package
//
// Boundary rules:
//   ✓ React hooks, @tanstack/react-query, zustand, @revamp/shared-types
//   ✗ next/*, react-dom, localStorage, window, process.env

// API
export { setApiClient, getApiClient } from './api/types';
export type { ApiClient, ApiResponse, RequestConfig } from './api/types';

// Query Keys
export { pipelineKeys, projectKeys, agentKeys } from './hooks/pipeline-keys';

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
