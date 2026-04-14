// ─── Stage Names & Labels ──────────────────────────────────────────
// Single source of truth: @revamp/shared-types — re-exported for convenience.

import {
  PipelineStageName,
  PIPELINE_STAGE_ORDER,
  STAGE_DISPLAY_LABELS,
  STAGES_REQUIRING_APPROVAL as _STAGES_REQUIRING_APPROVAL,
  stageRequiresApproval,
} from '@revamp/shared-types';

/** Ordered array of stage name strings. Derived from shared-types. */
export const STAGE_NAMES = PIPELINE_STAGE_ORDER as readonly string[];

/** Type for a valid stage name. */
export type StageName = PipelineStageName;

/** Human-readable labels for each stage. Derived from shared-types. */
export const STAGE_LABELS: Record<string, string> = STAGE_DISPLAY_LABELS;

export { stageRequiresApproval };

// ─── Types ─────────────────────────────────────────────────────────

export type StageStatus =
  | 'idle'
  | 'pending'
  | 'locked'
  | 'generating'
  | 'validating'
  | 'completed'
  | 'approved'
  | 'failed'
  | 'skipped';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'not_required';

export interface StageArtifact {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
  createdAt: string;
}

export interface ValidationDimensionScore {
  name: string;
  score: number;
  weight: number;
  details: string;
}

export interface ValidationFinding {
  id: string;
  category: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  codeLocation?: string;
}

export interface StageValidation {
  passed: boolean;
  score: number;  // 0-100 composite confidence score
  criteria: Array<{
    name: string;
    passed: boolean;
    score: number;
    feedback: string;
  }>;
  dimensionScores?: ValidationDimensionScore[];
  findings?: ValidationFinding[];
  summary: string;
  validatedAt: string;
}

export interface ApprovalHistoryEntry {
  action: 'approved' | 'rejected' | 'rerun' | 'auto_approved' | 'failed';
  timestamp: string;
  user: string;
  comment: string;
  autoApproved?: boolean;
  confidenceScore?: number;
}

export interface ScanSubtaskState {
  id: string;
  type: string;
  label: string;
  title?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
  agentName?: string;
  duration?: number;
  error?: string;
}

export interface StageState {
  name: string;
  /** Human-readable display label (e.g. "Spec Lock") */
  label: string;
  status: StageStatus;
  output: string;
  approvalStatus: ApprovalStatus;
  startedAt: string | null;
  completedAt: string | null;
  validation: StageValidation | null;
  /** Preserved on re-run for comparison */
  previousValidation: StageValidation | null;
  /** Full audit trail of approve/reject/rerun actions */
  approvalHistory: ApprovalHistoryEntry[];
  /** ISO timestamp when approval was first requested */
  pendingApprovalSince: string | null;
  artifacts: StageArtifact[];
  subtasks: ScanSubtaskState[];
  /** Overall progress across all gap-fill rounds, deduped by title with best-status-wins.
   *  Distinct from `subtasks.length` which only reflects the latest batch shown in the bot grid. */
  subtaskProgress?: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    rounds: number;
  };
  tokenUsage: { input: number; output: number; cost: number } | null;
  /** Execution progress percentage (0-100) */
  progress: number;
  errorMessage: string | null;
  /** Alias for errorMessage — used by some components as stage.error */
  error?: string | null;
  /** Number of times this stage has been executed */
  runCount: number;
}

// ─── Activity Store Types ──────────────────────────────────────────

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageByModel {
  [model: string]: { inputTokens: number; outputTokens: number; cost: number; count: number };
}

export interface UsageByStage {
  [stageName: string]: { inputTokens: number; outputTokens: number; cost: number; count: number };
}

export interface ModernizedFile {
  path: string;
  name?: string;
  content: string;
  language?: string;
  size?: number;
}

export interface FeatureFile {
  path: string;
  content: string;
  scenarioCount: number;
  passCount: number;
  failCount: number;
}

// ─── Default stage factory ─────────────────────────────────────────

export function createDefaultStage(name: string): StageState {
  return {
    name,
    label: STAGE_LABELS[name] ?? name,
    status: 'idle',
    output: '',
    approvalStatus: 'not_required',
    startedAt: null,
    completedAt: null,
    validation: null,
    previousValidation: null,
    approvalHistory: [],
    pendingApprovalSince: null,
    artifacts: [],
    subtasks: [],
    runCount: 0,
    tokenUsage: null,
    progress: 0,
    errorMessage: null,
  };
}

export function createDefaultStages(): StageState[] {
  return STAGE_NAMES.map((name) => createDefaultStage(name));
}

// ─── Selectors / Helpers ────────────────────────────────────────────

/** Default confidence threshold — can be overridden per-project via settings.confidenceThreshold */
export const DEFAULT_CONFIDENCE_THRESHOLD = 75;

/**
 * Returns true if a stage at the given index can be executed.
 * Rules:
 *   - All previous stages must be completed or approved
 *   - Current stage must NOT have a pending approval gate
 */
export function canExecuteStage(stages: StageState[], index: number): boolean {
  const current = stages[index];
  // Block if awaiting approval — user must approve/reject first
  if (current?.approvalStatus === 'pending' && current?.pendingApprovalSince) return false;

  if (index === 0) return true;
  for (let i = 0; i < index; i++) {
    const s = stages[i].status;
    if (s !== 'completed' && s !== 'approved') return false;
  }
  return true;
}

/**
 * Central guard: should the approval gate UI be shown for this stage?
 *
 * Rules (matching legacy-bridge):
 *   - Stage must have completed successfully (status = 'completed' or 'approved')
 *   - Stage must require approval
 *   - Stage must NOT be failed/pending/generating
 *   - Approval gate is for reviewing OUTPUT, not for recovering from errors
 */
export function shouldShowApprovalGate(stage: StageState): boolean {
  // Never show approval gate for running or failed stages
  if (stage.status === 'generating' || stage.status === 'validating' || stage.status === 'failed') {
    return false;
  }
  // Only show for stages that require approval
  if (!stageRequiresApproval(stage.name)) return false;
  // Show when completed, approved, OR has output (covers rehydration where status may lag behind data)
  return stage.status === 'completed' || stage.status === 'approved' || !!stage.output;
}

/**
 * Returns a human-readable reason why a stage cannot be executed yet.
 */
export function getStageBlockReason(stages: StageState[], index: number): string | null {
  // Check if current stage has pending approval — only block if the stage
  // actually has output awaiting review, not if it was just reset for rerun.
  const current = stages[index];
  if (current?.approvalStatus === 'pending' && current.status !== 'pending' && current.output) {
    return `This stage is awaiting approval. Review and approve or reject before re-running.`;
  }

  if (index === 0) return null;
  for (let i = 0; i < index; i++) {
    const s = stages[i];
    if (s.status !== 'completed' && s.status !== 'approved') {
      return `"${STAGE_LABELS[s.name] ?? s.name}" must be completed before this stage can run.`;
    }
  }
  return null;
}
