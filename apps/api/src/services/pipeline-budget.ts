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
import { pipelineRuns, budgetPolicies, budgetIncidents, costEvents } from "@/db/schema.js";
import { eq, and, sql, gte } from "drizzle-orm";

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

export class ProjectBudgetExceededError extends Error {
  constructor(
    public projectId: string,
    public budgetCents: number,
    public usedCents: number,
  ) {
    super(
      `Project budget exceeded: used ${usedCents}¢ of ${budgetCents}¢`,
    );
    this.name = "ProjectBudgetExceededError";
  }
}

export interface ProjectBudgetStatus {
  projectId: string;
  budgetCents: number | null;
  usedCents: number;
  remainingCents: number | null;
  percentUsed: number | null;
  exceeded: boolean;
  hardStop: boolean;
  window: string;
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
 * Pre-flight budget check. Checks BOTH pipeline-run budget AND project-level budget.
 * Throws PipelineBudgetExceededError or ProjectBudgetExceededError if over.
 */
export async function checkPipelineBudget(
  pipelineRunId: string,
  estimatedCents: number = 0,
): Promise<boolean> {
  // 1. Check pipeline-run budget
  const status = await getPipelineBudgetStatus(pipelineRunId);

  if (status.budgetCents !== null) {
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
  }

  // 2. Check project-level budget policy
  const run = await db.query.pipelineRuns.findFirst({
    where: eq(pipelineRuns.id, pipelineRunId),
    columns: { project_id: true },
  });

  if (run?.project_id) {
    const projectStatus = await getProjectBudgetStatus(run.project_id);
    if (projectStatus && projectStatus.hardStop && projectStatus.exceeded) {
      throw new ProjectBudgetExceededError(
        run.project_id, projectStatus.budgetCents!, projectStatus.usedCents,
      );
    }
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

// ─── PROJECT-LEVEL BUDGET ──────────────────────────────────────

/**
 * Get the active budget policy and current spend for a project.
 * Queries budget_policies (scope_type='project') and aggregates cost_events.
 */
export async function getProjectBudgetStatus(
  projectId: string,
): Promise<ProjectBudgetStatus | null> {
  // Find the active project budget policy
  const policy = await db.query.budgetPolicies.findFirst({
    where: and(
      eq(budgetPolicies.scope_type, "project"),
      eq(budgetPolicies.scope_id, projectId),
      eq(budgetPolicies.active, true),
    ),
  });

  if (!policy) return null;

  // Calculate spend within the policy window
  const windowStart = getWindowStart(policy.window);

  const spendResult = await db.execute(sql`
    SELECT COALESCE(SUM(cost_cents), 0)::int AS total_spent
    FROM cost_events
    WHERE project_id = ${projectId}
      AND created_at >= ${windowStart}
  `);

  const usedCents = (spendResult.rows?.[0] as any)?.total_spent ?? 0;
  const budgetCents = policy.limit_cents;
  const remainingCents = Math.max(0, budgetCents - usedCents);
  const percentUsed = budgetCents > 0 ? Math.round((usedCents / budgetCents) * 100) : 0;

  return {
    projectId,
    budgetCents,
    usedCents,
    remainingCents,
    percentUsed,
    exceeded: usedCents >= budgetCents,
    hardStop: policy.hard_stop,
    window: policy.window,
  };
}

/**
 * Record a project-level budget incident when threshold is crossed.
 */
export async function enforceProjectBudget(projectId: string): Promise<void> {
  const status = await getProjectBudgetStatus(projectId);
  if (!status || status.budgetCents === null) return;

  const policy = await db.query.budgetPolicies.findFirst({
    where: and(
      eq(budgetPolicies.scope_type, "project"),
      eq(budgetPolicies.scope_id, projectId),
      eq(budgetPolicies.active, true),
    ),
    columns: { id: true, warn_percent: true },
  });

  if (!policy) return;

  const warnAt = parseFloat(policy.warn_percent);
  const pctUsed = status.percentUsed! / 100;

  // Hard stop reached
  if (status.exceeded && status.hardStop) {
    const existing = await db.query.budgetIncidents.findFirst({
      where: and(
        eq(budgetIncidents.policy_id, policy.id),
        eq(budgetIncidents.incident_type, "hard_stop"),
        eq(budgetIncidents.resolved, false),
      ),
    });
    if (!existing) {
      await db.insert(budgetIncidents).values({
        policy_id: policy.id,
        incident_type: "hard_stop",
        current_spend_cents: status.usedCents,
        limit_cents: status.budgetCents!,
        percent_used: pctUsed.toFixed(2),
        action_taken: "execution_blocked",
      });
    }
    return;
  }

  // Warning threshold
  if (pctUsed >= warnAt && !status.exceeded) {
    const windowStart = getWindowStart(status.window);
    const existing = await db.query.budgetIncidents.findFirst({
      where: and(
        eq(budgetIncidents.policy_id, policy.id),
        eq(budgetIncidents.incident_type, "warning"),
        eq(budgetIncidents.resolved, false),
        gte(budgetIncidents.created_at, windowStart),
      ),
    });
    if (!existing) {
      await db.insert(budgetIncidents).values({
        policy_id: policy.id,
        incident_type: "warning",
        current_spend_cents: status.usedCents,
        limit_cents: status.budgetCents!,
        percent_used: pctUsed.toFixed(2),
        action_taken: "warning_logged",
      });
    }
  }
}

function getWindowStart(window: string): Date {
  const now = new Date();
  switch (window) {
    case "daily":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "monthly":
      return new Date(now.getFullYear(), now.getMonth(), 1);
    case "lifetime":
      return new Date(0);
    default:
      return new Date(now.getFullYear(), now.getMonth(), 1);
  }
}
