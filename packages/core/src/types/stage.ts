/**
 * Stage types, constants, and pure helper functions.
 *
 * Platform-independent — used by web, VS Code extension, and backend.
 * Moved from apps/web/lib/stores/pipeline-types.ts to @revamp/core.
 */

import {
  PipelineStageName,
  PIPELINE_STAGE_ORDER,
  STAGE_DISPLAY_LABELS,
  stageRequiresApproval,
} from '@revamp/shared-types';

// ─── Stage Names & Labels ──────────────────────────────────────────

export const STAGE_NAMES = PIPELINE_STAGE_ORDER as readonly string[];
export type StageName = PipelineStageName;
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
  score: number;
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
  label: string;
  status: StageStatus;
  output: string;
  approvalStatus: ApprovalStatus;
  startedAt: string | null;
  completedAt: string | null;
  validation: StageValidation | null;
  previousValidation: StageValidation | null;
  approvalHistory: ApprovalHistoryEntry[];
  pendingApprovalSince: string | null;
  artifacts: StageArtifact[];
  subtasks: ScanSubtaskState[];
  subtaskProgress?: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    rounds: number;
  };
  tokenUsage: { input: number; output: number; cost: number } | null;
  progress: number;
  errorMessage: string | null;
  error?: string | null;
  runCount: number;
}

// ─── Activity Types ──────────────────────────────────────────────

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

// ─── Factory ─────────────────────────────────────────────────────

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

// ─── Selectors / Helpers ────────────────────────────────────────

export const DEFAULT_CONFIDENCE_THRESHOLD = 75;

export function canExecuteStage(stages: StageState[], index: number): boolean {
  const current = stages[index];
  if (current?.approvalStatus === 'pending' && current?.pendingApprovalSince) return false;
  if (index === 0) return true;
  for (let i = 0; i < index; i++) {
    const s = stages[i].status;
    if (s !== 'completed' && s !== 'approved') return false;
  }
  return true;
}

export function shouldShowApprovalGate(stage: StageState): boolean {
  if (stage.status === 'generating' || stage.status === 'validating' || stage.status === 'failed') return false;
  if (!stageRequiresApproval(stage.name)) return false;
  return stage.status === 'completed' || stage.status === 'approved' || !!stage.output;
}

export function getStageBlockReason(stages: StageState[], index: number): string | null {
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
