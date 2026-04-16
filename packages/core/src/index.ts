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

// Notifications
export { setNotificationAdapter, getNotifier } from './api/notifications';
export type { NotificationAdapter } from './api/notifications';

// WebSocket
export { setWSManager, getWSManager } from './api/ws';
export type { WSManager, WSEvent } from './api/ws';

// Query Keys
export { pipelineKeys, projectKeys, agentKeys } from './hooks/pipeline-keys';

// Pipeline Hooks (platform-independent — uses injected API client)
export {
  useLatestPipelineRun,
  usePipelineStatus,
  usePipelineStatusV2,
  useStageOutput,
  useStageExecutionOutput,
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

// Hooks that import Zustand stores — NOT exported from barrel (same SSR issue).
// Import from specific files:
//   import { useAuth } from '@revamp/core/hooks/use-auth'
//   import { useAgentEvents } from '@revamp/core/hooks/use-agent-events'
//   import { useEvolveChat } from '@revamp/core/hooks/use-evolve-chat'
//   import { usePipelineShortcuts } from '@revamp/core/hooks/use-keyboard-shortcuts'
//   import { usePipelineData } from '@revamp/core/hooks/use-pipeline-data'
//   import { useStagePanel } from '@revamp/core/hooks/use-stage-panel'
//   import { useStageExecution } from '@revamp/core/hooks/use-stage-execution'
export type { AgentEvent, AgentEventType } from './hooks/use-agent-events';
export type { MergedStageState, PipelineData } from './hooks/use-pipeline-data';

// Stores — NOT exported from barrel to prevent SSR store creation.
// Import stores from their specific files:
//   import { useAuthStore } from '@revamp/core/stores/auth-store'
//   import { usePipelineStore } from '@revamp/core/stores/pipeline-store'
//   import { usePipelineConfigStore } from '@revamp/core/stores/pipeline-config-store'
//   import { usePipelineActivityStore } from '@revamp/core/stores/pipeline-activity-store'
//
// Zustand stores with persist() create side effects at import time
// (they call getPersistStorage() which needs browser localStorage).
// Exporting them from the barrel causes ALL stores to initialize
// when ANY file imports from @revamp/core — breaking SSR.
export type { User } from './stores/auth-store';

// Utilities
export { parseMarkdownSections, replaceSectionContent, getPreSectionText, getPostSectionText } from './utils/markdown-sections';
export type { MarkdownSection } from './utils/markdown-sections';

// Pipeline API Types
export type {
  PipelineStatus,
  PipelineStatusV2,
  StageStatusV2,
  StageExecutionEntry,
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
