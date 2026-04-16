/**
 * Pipeline Spend Recorder — single source of truth for LLM token + cost accounting.
 *
 * Writes one row to llm_usage (legacy schema) and one row to cost_events (with full
 * 4-way token breakdown and project-budget visibility). Calls per-run and per-project
 * budget hooks. Every error is logged and swallowed — accounting must never fail a stage.
 */

import { db } from "@/db/index.js";
import { llmUsage, costEvents } from "@/db/schema.js";
import {
  estimateCostCents,
  recordPipelineSpend,
  enforceProjectBudget,
} from "./pipeline-budget.js";
import type { OnStageEvent } from "@revamp/core-engine";
import type { PipelineStageName } from "@revamp/shared-types/pipeline";

export interface StageSpendContext {
  pipelineRunId: string;
  projectId: string;
  stageName: PipelineStageName;
  stageIndex: number;
  model: string;
  provider: string;
  /** Free-form caller tag — typical values: "stage" (default), "chunked", "refinement", "scan-orchestration". */
  operation?: string;
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
  };
  onEvent?: OnStageEvent;
}

export async function recordStageSpend(ctx: StageSpendContext): Promise<void> {
  const { tokens } = ctx;
  const totalTokens =
    tokens.inputTokens + tokens.outputTokens + tokens.cachedTokens + tokens.cacheCreationTokens;
  if (totalTokens === 0) return;

  const costCents = estimateCostCents(tokens, ctx.model);

  // 1) llm_usage — legacy table, aggregates only
  try {
    await db.insert(llmUsage).values({
      project_id: ctx.projectId,
      pipeline_run_id: ctx.pipelineRunId,
      model: ctx.model,
      input_tokens: tokens.inputTokens,   // regular input only (matches schema's historical semantics)
      output_tokens: tokens.outputTokens,
      cost: costCents,
    });
  } catch (err) {
    console.warn("[recordStageSpend] llm_usage insert failed:", err instanceof Error ? err.message : err);
  }

  // 2) cost_events — new source of truth for budgets
  try {
    await db.insert(costEvents).values({
      project_id: ctx.projectId,
      pipeline_run_id: ctx.pipelineRunId,
      provider: ctx.provider,
      model: ctx.model,
      input_tokens: tokens.inputTokens,
      output_tokens: tokens.outputTokens,
      cached_tokens: tokens.cachedTokens,
      cache_creation_tokens: tokens.cacheCreationTokens,
      cost_cents: costCents,
      stage_name: ctx.stageName,
      operation: ctx.operation ?? "stage",
    });
  } catch (err) {
    console.warn("[recordStageSpend] cost_events insert failed:", err instanceof Error ? err.message : err);
  }

  // 3) per-run counter
  try {
    await recordPipelineSpend(ctx.pipelineRunId, costCents);
  } catch (err) {
    console.warn("[recordStageSpend] recordPipelineSpend failed:", err instanceof Error ? err.message : err);
  }

  // 4) project-level budget incidents (non-fatal)
  try {
    await enforceProjectBudget(ctx.projectId);
  } catch (err) {
    console.warn("[recordStageSpend] enforceProjectBudget failed:", err instanceof Error ? err.message : err);
  }

  // 5) SSE / UI event
  try {
    ctx.onEvent?.({
      phase: "usage" as any,
      stageName: ctx.stageName,
      stageIndex: ctx.stageIndex,
      timestamp: new Date().toISOString(),
      data: {
        input_tokens: tokens.inputTokens,
        output_tokens: tokens.outputTokens,
        cached_tokens: tokens.cachedTokens,
        cache_creation_tokens: tokens.cacheCreationTokens,
        cost: costCents,
      },
    });
  } catch { /* non-fatal */ }
}
