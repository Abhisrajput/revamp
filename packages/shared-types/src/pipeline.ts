/**
 * Pipeline and workflow types for AIgnite - LAPM
 *
 * This is the SINGLE SOURCE OF TRUTH for all stage names, display labels,
 * ordering, and approval requirements across the entire platform.
 */

export enum PipelineStageName {
  SCAN = 'SCAN',
  DECODE = 'DECODE',
  BLUEPRINT = 'BLUEPRINT',
  SPEC_LOCK = 'SPEC_LOCK',
  ARCHITECT = 'ARCHITECT',
  FORGE = 'FORGE',
  SHADOW_RUN = 'SHADOW_RUN',
  EVOLVE = 'EVOLVE',
}

/** Ordered array of stage names — defines pipeline execution sequence. */
export const PIPELINE_STAGE_ORDER: PipelineStageName[] = [
  PipelineStageName.SCAN,
  PipelineStageName.DECODE,
  PipelineStageName.BLUEPRINT,
  PipelineStageName.SPEC_LOCK,
  PipelineStageName.ARCHITECT,
  PipelineStageName.FORGE,
  PipelineStageName.SHADOW_RUN,
  PipelineStageName.EVOLVE,
];

/** Human-readable display labels for each stage. */
export const STAGE_DISPLAY_LABELS: Record<PipelineStageName, string> = {
  [PipelineStageName.SCAN]: 'Setup',
  [PipelineStageName.DECODE]: 'Intent Extraction',
  [PipelineStageName.BLUEPRINT]: 'Business Capability Map',
  [PipelineStageName.SPEC_LOCK]: 'Behavior Lock-in',
  [PipelineStageName.ARCHITECT]: 'Modernization Approach',
  [PipelineStageName.FORGE]: 'CoCreate',
  [PipelineStageName.SHADOW_RUN]: 'Parallel Run',
  [PipelineStageName.EVOLVE]: 'Continuous Modernization',
};

/** Every stage requires human review and approval before the next stage runs. */
export const STAGES_REQUIRING_APPROVAL: ReadonlySet<PipelineStageName> = new Set([
  PipelineStageName.SCAN,
  PipelineStageName.DECODE,
  PipelineStageName.BLUEPRINT,
  PipelineStageName.SPEC_LOCK,
  PipelineStageName.ARCHITECT,
  PipelineStageName.FORGE,
  PipelineStageName.SHADOW_RUN,
  PipelineStageName.EVOLVE,
]);

/** Helper — check whether a stage needs approval before it can run. */
export function stageRequiresApproval(stageName: string): boolean {
  return STAGES_REQUIRING_APPROVAL.has(stageName as PipelineStageName);
}

export enum StageStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
  AWAITING_APPROVAL = 'AWAITING_APPROVAL',
}

export interface StageArtifact {
  id: string;
  type: string; // e.g., "analysis", "recommendation", "code", "diagram"
  name: string;
  contentType: string;
  size: number;
  url: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PipelineStageRun {
  id: string;
  stageName: PipelineStageName;
  stageOrder: number;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  errorMessage?: string;
  artifacts: StageArtifact[];
  output?: Record<string, unknown>;
  duration?: number; // milliseconds
}

export interface ApprovalGate {
  id: string;
  pipelineRunId: string;
  stageName: PipelineStageName;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  respondedAt?: string;
  reviewedBy?: string;
  reviewerNotes?: string;
  requiredApprovers: number;
  currentApprovals: number;
  approvers: Array<{
    userId: string;
    email: string;
    approved: boolean;
    approvedAt?: string;
    notes?: string;
  }>;
}

export interface PipelineRun {
  id: string;
  projectId: string;
  pipelineId: string;
  name: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  stages: PipelineStageRun[];
  approvalGates: ApprovalGate[];
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  duration?: number; // milliseconds
  initiatedBy: string;
  parameters?: Record<string, unknown>;
  metrics?: {
    totalArtifacts: number;
    totalDuration: number;
    successRate: number;
  };
}

export interface Pipeline {
  id: string;
  projectId: string;
  name: string;
  description: string;
  stages: PipelineStageName[];
  requiresApprovalAtStages: PipelineStageName[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  isActive: boolean;
}

export interface CreatePipelineRequest {
  name: string;
  description: string;
  stages: PipelineStageName[];
  requiresApprovalAtStages?: PipelineStageName[];
}

export interface RunPipelineRequest {
  pipelineId: string;
  parameters?: Record<string, unknown>;
  skipStages?: PipelineStageName[];
}

export interface PipelineMetrics {
  pipelineId: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  averageDuration: number;
  successRate: number;
  lastRunAt?: string;
  nextScheduledRun?: string;
}

export interface StreamUpdate {
  type: 'stage_progress' | 'artifact' | 'log' | 'error' | 'completion';
  pipelineRunId: string;
  stageName?: PipelineStageName;
  timestamp: string;
  data: Record<string, unknown>;
  progress?: {
    current: number;
    total: number;
    percentage: number;
  };
}
