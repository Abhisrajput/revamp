/**
 * Shared types for all stage panel components.
 */

import type { StageState } from '@/lib/stores/pipeline-types';

export interface StagePanelProps {
  /** Current stage state from pipeline store */
  stage: StageState;
  /** Stage index (0-7) */
  stageIndex: number;
  /** Text being streamed from the LLM */
  streamingText: string;
  /** Project data from the API */
  project: any;
  /** Pipeline run ID */
  pipelineRunId: string | null;
  /** Trigger stage execution */
  onExecute: () => void;
  /** Stop current execution */
  onStop?: () => void;
  /** Approve the stage (for approval gates) */
  onApprove: (comment?: string) => void;
  /** Reject the stage (for approval gates) */
  onReject: (reason: string) => void;
  /** Whether execution is currently in progress */
  isExecuting: boolean;
  /** Current execution phase name */
  currentPhase: string | null;
  /** Refine a markdown section via LLM */
  onRefineRequest?: (context: {
    sectionTitle: string;
    sectionContent: string;
    userFeedback: string;
    fullText: string;
  }) => Promise<string>;
}
