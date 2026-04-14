

import { usePipelineStore } from '../stores/pipeline-store';
import { usePipelineActivityStore } from '../stores/pipeline-activity-store';
import { canExecuteStage, type StageState } from '../types/stage';

/**
 * Shared hook for stage panel boilerplate.
 * Extracts the repeated store subscriptions and derived state
 * that every stage panel computes identically.
 */
export function useStagePanel(
  stage: StageState,
  stageIndex: number,
  streamingText: string,
  isExecuting: boolean,
) {
  const logs = usePipelineActivityStore((s) => s.logs);
  const stages = usePipelineStore((s) => s.stages);
  const isRunning = stage.status === 'generating' || stage.status === 'validating';
  const hasOutput = !!(stage.output || streamingText);
  const canRun =
    (stage.status === 'pending' || stage.status === 'failed') &&
    !isExecuting &&
    canExecuteStage(stages, stageIndex);

  return { logs, stages, isRunning, hasOutput, canRun };
}
