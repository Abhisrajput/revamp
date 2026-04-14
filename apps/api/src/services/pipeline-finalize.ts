/**
 * Pipeline Stage Finalization — shared post-execution logic for all stage handlers.
 *
 * After any stage (SCAN, DECODE, FORGE, generic) produces a result:
 *   1. Store output + validation artifacts
 *   2. Record agent completion
 *   3. Record token usage + cost
 *   4. Update stage progress + create approval gate
 *   5. Emit completion/failure events
 *   6. Update project metrics
 */

import { db } from "@/db/index.js";
import { llmUsage } from "@/db/schema.js";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import type { StageRunResult, OnStageEvent } from "@revamp/core-engine";
import type { AgentStageContext } from "./agent-pipeline.js";
import { recordAgentCompletion } from "./agent-pipeline.js";
import {
  updateStageProgress,
  createApprovalGate,
  storeStageOutput,
  updateProjectMetrics,
} from "./pipeline-repository.js";
import { getStageConfig } from "./pipeline-config.js";
import {
  recordPipelineSpend,
  estimateCostCents,
} from "./pipeline-budget.js";
import {
  emitStageCompleted,
  emitStageFailed,
} from "./pipeline-event-bus.js";
import crypto from "crypto";

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
  const { pipelineRunId, projectId, stageName, stageIndex, result, modelName, agentCtx, agentExec, onEvent } = opts;

  if (!result.output) {
    await updateStageProgress(pipelineRunId, stageName, "failed", 0);
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

  // 3. Record token usage (estimated from content sizes)
  try {
    const estimatedInputTokens = Math.round(
      (result.phases?.reduce((s: number, p: any) => s + (JSON.stringify(p.data || '').length), 0) || 4000) / 4
    );
    const estimatedOutputTokens = Math.round((result.output.length || 0) / 4);
    if (estimatedOutputTokens > 0) {
      const cost = estimateCostCents(estimatedInputTokens, estimatedOutputTokens, modelName);
      await recordPipelineSpend(pipelineRunId, cost);
      await db.insert(llmUsage).values({
        id: crypto.randomUUID(),
        project_id: projectId,
        pipeline_run_id: pipelineRunId,
        model: modelName || "unknown",
        input_tokens: estimatedInputTokens,
        output_tokens: estimatedOutputTokens,
        cost: Math.round(cost),
      });
      onEvent?.({
        phase: 'usage' as any,
        stageName,
        stageIndex,
        timestamp: new Date().toISOString(),
        data: { input_tokens: estimatedInputTokens, output_tokens: estimatedOutputTokens, cost },
      });
    }
  } catch { /* non-fatal */ }

  // 4. Update stage progress + create approval gate
  const score = result.validation?.confidenceScore ?? 70;
  const config = getStageConfig(stageName);
  await db.transaction(async (tx) => {
    await updateStageProgress(pipelineRunId, stageName, "completed", 100, { conn: tx, confidenceScore: score });
    if (config.requiresApproval) {
      await createApprovalGate(pipelineRunId, stageName, config.requiredRole || "admin", tx);
      await updateStageProgress(pipelineRunId, stageName, "awaiting_approval", 100, { conn: tx, confidenceScore: score });
    }
  });

  // 5. Emit completion event
  emitStageCompleted({ pipelineRunId, projectId, stageName, duration: result.duration, confidenceScore: score });

  // 6. Update project metrics (non-fatal)
  await updateProjectMetrics(projectId, pipelineRunId, result);
}
