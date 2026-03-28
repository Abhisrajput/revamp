/**
 * Pipeline Budget Service — per-run budget control for pipeline execution.
 *
 * Complements the agent-level budget-enforcement.ts with run-level controls:
 *   - Each pipeline run can have an optional budget_cents cap
 *   - Pre-flight check before every LLM call
 *   - Atomic spend recording after each LLM response
 *   - Budget-aware LLM call wrapper for easy integration
 *
 * Inspired by Paperclip's cascading budget pattern:
 *   company budget → project budget → run budget → per-stage
 */

import { db } from "@/db/index.js";
import { pipelineRuns } from "@/db/schema.js";
import { eq, sql } from "drizzle-orm";

// ─── TYPES ──────────────────────────────────────────────────────

export interface PipelineBudgetStatus {
  budgetCents: number | null;
  usedCents: number;
  remainingCents: number | null;
  percentUsed: number | null;
  exceeded: boolean;
}

export class PipelineBudgetExceededError extends Error {
  constructor(
    public pipelineRunId: string,
    public budgetCents: number,
    public usedCents: number,
    public requestedCents: number,
  ) {
    super(
      `Pipeline run budget exceeded: used ${usedCents}¢ of ${budgetCents}¢, ` +
      `requested ${requestedCents}¢ more`,
    );
    this.name = "PipelineBudgetExceededError";
  }
}

// ─── COST ESTIMATION ─────────────────────────────────────────────

const MODEL_COST_PER_1K: Record<string, { input: number; output: number }> = {
  sonnet:          { input: 0.3,   output: 1.5 },
  haiku:           { input: 0.025, output: 0.125 },
  flash:           { input: 0.0375, output: 0.15 },
  "gpt-4o":        { input: 0.25,  output: 1.0 },
  "gpt-4":         { input: 3.0,   output: 6.0 },
  default:         { input: 0.3,   output: 1.5 },
};

export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
  model: string = "default",
): number {
  const modelLower = model.toLowerCase();
  let pricing = MODEL_COST_PER_1K.default;

  for (const [key, cost] of Object.entries(MODEL_COST_PER_1K)) {
    if (key !== "default" && modelLower.includes(key)) {
      pricing = cost;
      break;
    }
  }

  const inputCost = (inputTokens / 1000) * pricing.input;
  const outputCost = (outputTokens / 1000) * pricing.output;
  return Math.round((inputCost + outputCost) * 100) / 100;
}

// ─── BUDGET OPERATIONS ──────────────────────────────────────────

export async function getPipelineBudgetStatus(
  pipelineRunId: string,
): Promise<PipelineBudgetStatus> {
  const run = await db.query.pipelineRuns.findFirst({
    where: eq(pipelineRuns.id, pipelineRunId),
    columns: { budget_cents: true, budget_used_cents: true },
  });

  if (!run) {
    return { budgetCents: null, usedCents: 0, remainingCents: null, percentUsed: null, exceeded: false };
  }

  const budgetCents = run.budget_cents;
  const usedCents = run.budget_used_cents;

  if (budgetCents === null) {
    return { budgetCents: null, usedCents, remainingCents: null, percentUsed: null, exceeded: false };
  }

  const remainingCents = Math.max(0, budgetCents - usedCents);
  const percentUsed = Math.round((usedCents / budgetCents) * 100);

  return {
    budgetCents,
    usedCents,
    remainingCents,
    percentUsed,
    exceeded: usedCents >= budgetCents,
  };
}

/**
 * Pre-flight budget check. Throws PipelineBudgetExceededError if over.
 */
export async function checkPipelineBudget(
  pipelineRunId: string,
  estimatedCents: number = 0,
): Promise<boolean> {
  const status = await getPipelineBudgetStatus(pipelineRunId);

  if (status.budgetCents === null) return true;

  if (status.exceeded) {
    throw new PipelineBudgetExceededError(
      pipelineRunId, status.budgetCents, status.usedCents, estimatedCents,
    );
  }

  if (estimatedCents > 0 && status.usedCents + estimatedCents > status.budgetCents) {
    throw new PipelineBudgetExceededError(
      pipelineRunId, status.budgetCents, status.usedCents, estimatedCents,
    );
  }

  return true;
}

/**
 * Atomically record spend after an LLM call. Uses SQL increment for concurrency safety.
 */
export async function recordPipelineSpend(
  pipelineRunId: string,
  costCents: number,
): Promise<PipelineBudgetStatus> {
  if (costCents <= 0) return getPipelineBudgetStatus(pipelineRunId);

  await db
    .update(pipelineRuns)
    .set({
      budget_used_cents: sql`${pipelineRuns.budget_used_cents} + ${Math.round(costCents)}`,
      updated_at: new Date(),
    })
    .where(eq(pipelineRuns.id, pipelineRunId));

  return getPipelineBudgetStatus(pipelineRunId);
}

/**
 * Set budget for a pipeline run (at creation or update).
 */
export async function setPipelineBudget(
  pipelineRunId: string,
  budgetCents: number | null,
): Promise<void> {
  await db
    .update(pipelineRuns)
    .set({ budget_cents: budgetCents, updated_at: new Date() })
    .where(eq(pipelineRuns.id, pipelineRunId));
}

// ─── BUDGET-AWARE LLM WRAPPER ───────────────────────────────────

/**
 * Wrap an LLM call function with pipeline-level budget enforcement.
 *
 * Usage in orchestrators:
 *   const budgetedFn = withPipelineBudget(baseLlmCallFn, pipelineRunId, model);
 *   const result = await budgetedFn({ systemPrompt, userPrompt });
 */
export function withPipelineBudget(
  baseFn: (req: { systemPrompt: string; userPrompt: string }) => Promise<string>,
  pipelineRunId: string,
  model: string = "default",
): (req: { systemPrompt: string; userPrompt: string }) => Promise<string> {
  return async (req) => {
    // Estimate cost from prompt size (~4 chars per token)
    const estimatedInputTokens = Math.round(
      (req.systemPrompt.length + req.userPrompt.length) / 4,
    );
    const estimatedOutputTokens = 4000;
    const estimatedCost = estimateCostCents(estimatedInputTokens, estimatedOutputTokens, model);

    await checkPipelineBudget(pipelineRunId, estimatedCost);

    const result = await baseFn(req);

    // Record actual spend
    const actualOutputTokens = Math.round(result.length / 4);
    const actualCost = estimateCostCents(estimatedInputTokens, actualOutputTokens, model);
    await recordPipelineSpend(pipelineRunId, actualCost);

    return result;
  };
}
