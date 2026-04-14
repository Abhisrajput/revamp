/**
 * Pipeline types — re-exported from @revamp/core.
 *
 * All types, constants, and helpers now live in the shared package.
 * This file exists for backward compatibility so existing imports
 * from '@/lib/stores/pipeline-types' continue to work.
 *
 * New code should import from '@revamp/core' directly.
 */

export {
  // Constants
  STAGE_NAMES,
  STAGE_LABELS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  stageRequiresApproval,

  // Factory
  createDefaultStage,
  createDefaultStages,

  // Helpers
  canExecuteStage,
  shouldShowApprovalGate,
  getStageBlockReason,
} from '@revamp/core';

export type {
  // Stage types
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

  // Activity types
  RunUsage,
  UsageByModel,
  UsageByStage,
  ModernizedFile,
  FeatureFile,
} from '@revamp/core';
