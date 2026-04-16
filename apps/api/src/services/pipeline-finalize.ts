/**
 * Pipeline Stage Finalization — shared post-execution logic for all stage handlers.
 *
 * After any stage (SCAN, DECODE, FORGE, generic) produces a result:
 *   1. Store output + validation artifacts
 *   2. Record agent completion
 *   3. Complete stage execution + set approval status
 *   4. Emit completion/failure events
 *   5. Update project metrics
 *
 * Spend recording is NOT done here — callers invoke recordStageSpend() before
 * calling finalizeStageResult so that actual token counts (not estimates) are used.
 */

import { PipelineStageName } from "@revamp/shared-types/pipeline";
import type { StageRunResult, OnStageEvent } from "@revamp/core-engine";
import type { AgentStageContext } from "./agent-pipeline.js";
import { recordAgentCompletion } from "./agent-pipeline.js";
import {
  storeStageOutput,
  updateProjectMetrics,
} from "./pipeline-repository.js";
import {
  getLatestExecution,
  completeExecution,
  failExecution,
  setApprovalStatus,
} from "./stage-execution-repository.js";
import { getStageConfig } from "./pipeline-config.js";
import {
  emitStageCompleted,
  emitStageFailed,
} from "./pipeline-event-bus.js";

export interface FinalizeOptions {
  pipelineRunId: string;
  projectId: string;
  stageName: PipelineStageName;
  stageIndex: number;
  result: StageRunResult;
  modelName: string;
  agentCtx: AgentStageContext | null;
  agentExec: { complete: () => Promise<void> } | null;
  onEvent?: OnStageEvent;
}

/**
 * Finalize a stage execution — store output, record usage, update progress.
 * Shared by SCAN, DECODE, FORGE, and generic stage handlers.
 */
export async function finalizeStageResult(opts: FinalizeOptions): Promise<void> {
  const { pipelineRunId, projectId, stageName, result, modelName, agentCtx, agentExec } = opts;

  if (!result.output) {
    // Mark stage execution as failed
    const failedExec = await getLatestExecution(pipelineRunId, stageName);
    if (failedExec && failedExec.status === 'running') {
      await failExecution({ executionId: failedExec.id, errorMessage: `${stageName} produced no output` }).catch(() => {});
    }
    emitStageFailed({ pipelineRunId, projectId, stageName, error: `${stageName} produced no output` });
    return;
  }

  // 1. Store output + validation artifacts
  await storeStageOutput(pipelineRunId, stageName, result);

  // 2. Record agent completion
  if (agentCtx) {
    try {
      await recordAgentCompletion(
        agentCtx,
        {
          costCents: 0,
          tokensUsed: 0,
          refinementCount: result.refinementCount,
          result: { orchestrated: true },
        },
        pipelineRunId,
        "auto",
        modelName || "default",
        0, 0,
        stageName,
      );
    } catch { /* non-fatal */ }
    if (agentExec) {
      try { await agentExec.complete(); } catch { /* non-fatal */ }
    }
  }

  // 3. Complete stage execution and set approval status
  const score = result.validation?.confidenceScore ?? 70;
  const config = getStageConfig(stageName);
  const latestExec = await getLatestExecution(pipelineRunId, stageName);
  if (latestExec && latestExec.status === 'running') {
    await completeExecution({
      executionId: latestExec.id,
      output: result.output,
      validation: result.validation ? {
        passed: result.validation.passed,
        confidenceScore: result.validation.confidenceScore,
        issues: result.validation.issues,
        recommendations: result.validation.recommendations,
      } : undefined,
    }).catch(() => {});
    if (config.requiresApproval) {
      await setApprovalStatus(pipelineRunId, stageName, "pending").catch(() => {});
    }
  }

  // 5. Emit completion event
  emitStageCompleted({ pipelineRunId, projectId, stageName, duration: result.duration, confidenceScore: score });

  // 6. Update project metrics (non-fatal)
  await updateProjectMetrics(projectId, pipelineRunId, result);
}
