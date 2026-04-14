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

// Auth Hook
export { useAuth } from './hooks/use-auth';

// Agent Events Hook
export { useAgentEvents } from './hooks/use-agent-events';
export type { AgentEvent, AgentEventType } from './hooks/use-agent-events';

// Evolve Chat Hook
export { useEvolveChat } from './hooks/use-evolve-chat';

// Keyboard Shortcuts Hook
export { usePipelineShortcuts } from './hooks/use-keyboard-shortcuts';

// Pipeline Data Bridge Hook
export { usePipelineData } from './hooks/use-pipeline-data';
export type { MergedStageState, PipelineData } from './hooks/use-pipeline-data';

// Stage Panel Hook
export { useStagePanel } from './hooks/use-stage-panel';

// Stage Execution Hook (SSE streaming)
export { useStageExecution } from './hooks/use-stage-execution';

// Stores (platform-independent — uses injected storage adapters)
export { useAuthStore, useAuthHydrated } from './stores/auth-store';
export type { User } from './stores/auth-store';
export { usePipelineActivityStore } from './stores/pipeline-activity-store';
export { usePipelineConfigStore } from './stores/pipeline-config-store';
export { usePipelineStore } from './stores/pipeline-store';

// Utilities
export { parseMarkdownSections, replaceSectionContent, getPreSectionText, getPostSectionText } from './utils/markdown-sections';
export type { MarkdownSection } from './utils/markdown-sections';

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
