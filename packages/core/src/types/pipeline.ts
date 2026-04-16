/**
 * Pipeline data types shared across all apps.
 *
 * These match the backend API responses and are used by:
 * - React Query hooks (data shape)
 * - Zustand stores (state shape)
 * - Components (props)
 */

/** Backend stage_progress entry from GET /pipeline/:id/status */
export interface StageProgressEntry {
  status: string;
  progress?: number;
  confidenceScore?: number;
  startedAt?: string;
  updatedAt?: string;
}

/** Backend approval gate */
export interface ApprovalGate {
  id: string;
  stage_name: string;
  status: string;
  required_role: string;
  approved_by?: string;
  approval_comment?: string;
  approved_at?: string;
}

/** Subtask from the backend */
export interface SubtaskEntry {
  id: string;
  title: string;
  priority?: string;
  status: string;
  cost_cents?: number;
  type?: string;
  agent_name?: string;
  duration_ms?: number;
  error?: string;
}

/** Full pipeline status from GET /pipeline/:id/status */
export interface PipelineStatus {
  id: string;
  status: string;
  current_stage: string;
  stage_progress: Record<string, StageProgressEntry>;
  current_stage_subtasks?: SubtaskEntry[];
  current_stage_progress?: {
    total: number;
    completed: number;
    running: number;
    failed: number;
    pending: number;
    rounds: number;
  };
  error_message?: string;
  started_at?: string;
  completed_at?: string;
  artifacts?: Array<{ id: string; stage_name: string; artifact_type: string; created_at: string }>;
  approval_gates?: ApprovalGate[];
}

/** Stage execution summary from GET /pipeline/:id/status/v2 */
export interface StageExecutionEntry {
  id: string;
  version: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  output_length: number;
  approval_status: string;
  approved_at: string | null;
  validation: { passed?: boolean; confidenceScore?: number; criteria?: unknown[]; summary?: string } | null;
  model: string | null;
  token_usage: { input?: number; output?: number; cost?: number } | null;
  input_refs: Record<string, string>;
  error_message: string | null;
}

/** Per-stage status from v2 endpoint */
export interface StageStatusV2 {
  latest: StageExecutionEntry | null;
  versions: number[];
  stale: boolean;
  stale_reason: string | null;
}

/** Full pipeline status from GET /pipeline/:id/status/v2 */
export interface PipelineStatusV2 {
  id: string;
  project_id: string;
  status: string;
  stages: Record<string, StageStatusV2>;
}

/** Parsed validation result from artifact metadata */
export interface ValidationResult {
  passed: boolean;
  confidenceScore: number;
  deterministicResults: Array<{
    name: string;
    status: string;
    score: number;
    message: string;
    weight?: number;
  }>;
  llmResults: Array<{
    dimension: string;
    score: number;
    weight: number;
    reasoning: string;
  }>;
  issues: Array<{
    id: string;
    code: string;
    severity: string;
    title: string;
    description: string;
  }>;
  recommendations: string[];
  contractViolations: Array<{
    type: string;
    severity: string;
    description: string;
    section?: string;
  }>;
}
