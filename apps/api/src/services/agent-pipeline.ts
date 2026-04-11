/**
 * Agent-Pipeline Integration — bridges agent assignment into stage execution.
 *
 * When a stage is about to execute, this service:
 *   1. Finds the best-matched agent for the stage requirements
 *   2. Creates an agent assignment record
 *   3. Returns agent context (system prompt, model, permissions) to the caller
 *   4. After execution, records cost and completes the assignment
 *
 * Falls back gracefully to direct LLM execution if no agents are available.
 */

import crypto from "crypto";
import { db } from "@/db/index.js";
import { agentPersonas, agentAssignments } from "@/db/schema.js";
import { isNull, eq, sql } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { matchAgentToTask, type TaskRequirements } from "@revamp/core-engine";
import type { AgentPersona } from "@revamp/shared-types/agent";
import {
  assignTask,
  checkoutTask,
  completeTask,
  recordCostEvent,
  checkBudget,
} from "./agent-department.js";
import { enforceBudget } from "./budget-enforcement.js";
import {
  buildSessionContext,
  createSession,
  compactSessionChain,
  type SessionData,
} from "./agent-sessions.js";
import { retrieveEvolutionMemories } from "./agent-evolution.js";
import { extractEvolutionLearnings } from "./agent-evolution.js";

// ─── TYPES ──────────────────────────────────────────────────────

export interface AgentStageContext {
  agentId: string;
  agentName: string;
  assignmentId: string;
  systemPrompt: string;
  preferredProvider: string | null;
  preferredModel: string | null;
  evaluatorModel: string | null;
  toolPermissions: string[];
  stagePermissions: string[];
  /** Injected session context from prior stage executions */
  sessionContext: string;
  /** Accumulated evolution knowledge from prior pipeline runs (OpenViking pattern) */
  evolutionContext: string;
}

export interface StageAgentResult {
  costCents: number;
  tokensUsed: number;
  refinementCount: number;
  result: Record<string, unknown>;
}

// ─── MATCH AGENT TO STAGE ───────────────────────────────────────

/**
 * Attempt to find and assign the best agent for a pipeline stage.
 * Returns null if no suitable agent is available (caller should fall back to direct LLM).
 */
export async function matchAndAssignAgent(
  pipelineRunId: string,
  stageName: PipelineStageName,
  stageKeywords: string[],
  techStack: string[],
): Promise<AgentStageContext | null> {
  // Load all available agents
  const agents = await db.query.agentPersonas.findMany({
    where: isNull(agentPersonas.hidden_at),
  });

  if (agents.length === 0) return null;

  // Count active (in_progress) assignments per agent so the skill matcher
  // can enforce max_concurrent_tasks instead of blocking all "working" agents.
  const activeCountRows = await db
    .select({
      agentId: agentAssignments.agent_id,
      count: sql<number>`count(*)::int`,
    })
    .from(agentAssignments)
    .where(eq(agentAssignments.status, "in_progress"))
    .groupBy(agentAssignments.agent_id);

  const activeCountMap = new Map<string, number>();
  for (const row of activeCountRows) {
    if (row.agentId) activeCountMap.set(row.agentId, row.count);
  }

  // Convert to shared-types format for the matcher
  const personaList: AgentPersona[] = agents.map((a) => {
    const persona: AgentPersona = {
      id: a.id,
      name: a.name,
      slug: a.slug,
      role: a.role as AgentPersona["role"],
      department: a.department as AgentPersona["department"],
      status: a.status as AgentPersona["status"],
      pauseReason: a.pause_reason,
      systemPrompt: a.system_prompt,
      skills: (a.skills as AgentPersona["skills"]) || [],
      techStack: (a.tech_stack as string[]) || [],
      legacyExpertise: (a.legacy_expertise as string[]) || [],
      modernExpertise: (a.modern_expertise as string[]) || [],
      toolPermissions: (a.tool_permissions as AgentPersona["toolPermissions"]) || [],
      stagePermissions: (a.stage_permissions as string[]) || [],
      preferredProvider: a.preferred_provider,
      preferredModel: a.preferred_model,
      evaluatorModel: a.evaluator_model,
      maxConcurrentTasks: a.max_concurrent_tasks,
      reportsTo: a.reports_to,
      canDelegate: a.can_delegate,
      escalationTarget: a.escalation_target,
      monthlyBudgetCents: a.monthly_budget_cents,
      lifetimeBudgetCents: a.lifetime_budget_cents,
      hardStopEnabled: a.hard_stop_enabled,
      warningThreshold: parseFloat(a.warning_threshold),
      spentMonthlyCents: a.spent_monthly_cents,
      sessionCompactionThreshold: a.session_compaction_threshold,
      memoryStrategy: a.memory_strategy as AgentPersona["memoryStrategy"],
      version: a.version,
      createdAt: a.created_at.toISOString(),
      updatedAt: a.updated_at.toISOString(),
      hiddenAt: a.hidden_at?.toISOString() ?? null,
    };
    // Annotate with live active task count for the skill matcher
    persona.activeTasks = activeCountMap.get(a.id) ?? 0;
    return persona;
  });

  // Match agents to the stage
  const taskReq: TaskRequirements = {
    keywords: stageKeywords,
    techStack,
    stageName,
  };
  const matches = matchAgentToTask(taskReq, personaList);

  // Find the best available agent (must be idle and within budget)
  for (const match of matches) {
    if (match.score < 0.1) break; // too low

    const budget = await checkBudget(match.agent.id);
    if (!budget.allowed) continue;

    // Create assignment
    const assignment = await assignTask(
      match.agent.id,
      pipelineRunId,
      stageName,
      match.score,
    );

    // Attempt atomic checkout
    const runId = crypto.randomUUID();
    const checked = await checkoutTask(assignment.id, runId);
    if (!checked) continue; // race condition, try next

    // Load session context from prior stage executions
    let sessionContext = "";
    try {
      const ctx = await buildSessionContext(match.agent.id, pipelineRunId);
      sessionContext = ctx.contextSummary;
    } catch {
      // Non-fatal: continue without session context
    }

    // Load evolution memories from prior pipeline runs (OpenViking pattern)
    let evolutionContext = "";
    try {
      const memories = await retrieveEvolutionMemories(
        match.agent.id,
        stageName,
        techStack,
        5,
      );
      if (memories.length > 0) {
        evolutionContext = memories
          .map((m) => `[${m.category}] (confidence: ${m.confidence.toFixed(2)}) ${m.summary}`)
          .join("\n");
      }
    } catch {
      // Non-fatal: continue without evolution context
    }

    return {
      agentId: match.agent.id,
      agentName: match.agent.name,
      assignmentId: assignment.id,
      systemPrompt: match.agent.systemPrompt,
      preferredProvider: match.agent.preferredProvider ?? null,
      preferredModel: match.agent.preferredModel ?? null,
      evaluatorModel: match.agent.evaluatorModel ?? null,
      toolPermissions: match.agent.toolPermissions,
      stagePermissions: match.agent.stagePermissions,
      sessionContext,
      evolutionContext,
    };
  }

  return null; // no suitable agent
}

// ─── RECORD AGENT COMPLETION ────────────────────────────────────

/**
 * After a stage finishes, record the agent's work and costs.
 */
export async function recordAgentCompletion(
  ctx: AgentStageContext,
  result: StageAgentResult,
  pipelineRunId: string,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  stageName?: string,
): Promise<void> {
  // Complete the assignment
  await completeTask(
    ctx.assignmentId,
    result.result,
    result.costCents,
    result.tokensUsed,
    result.refinementCount,
  );

  // Record immutable cost event
  await recordCostEvent({
    agent_id: ctx.agentId,
    pipeline_run_id: pipelineRunId,
    assignment_id: ctx.assignmentId,
    provider,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_cents: result.costCents,
  });

  // Enforce budget — may pause the agent if thresholds are crossed
  try {
    await enforceBudget(ctx.agentId);
  } catch {
    // Non-fatal: budget enforcement should never block pipeline completion
  }

  // Save session for context continuity across stages
  try {
    const sessionData: SessionData = {
      stageContext: {
        stage: stageName || "unknown",
        model,
        provider,
        tokensUsed: result.tokensUsed,
        costCents: result.costCents,
      },
      findings: extractFindings(result.result),
      decisions: extractDecisions(result.result),
    };

    await createSession({
      agentId: ctx.agentId,
      taskId: pipelineRunId,
      pipelineRunId,
      sessionData,
      tokenCount: result.tokensUsed,
    });

    // Compact if the chain is getting long
    await compactSessionChain(ctx.agentId, pipelineRunId);
  } catch {
    // Non-fatal: session saving should never block pipeline
  }

  // Fire-and-forget: extract evolution learnings (OpenViking pattern)
  if (stageName) {
    const stageOutput = typeof result.result?.output === "string"
      ? result.result.output
      : JSON.stringify(result.result).slice(0, 6000);
    extractEvolutionLearnings({
      agentId: ctx.agentId,
      pipelineRunId,
      stageName,
      stageOutput,
      findings: extractFindings(result.result),
      decisions: extractDecisions(result.result),
    }).catch((err) => {
      console.error('[AgentPipeline] failed to save session data:', err instanceof Error ? err.message : err);
    });
  }
}

// ─── SESSION DATA EXTRACTORS ────────────────────────────────────

function extractFindings(result: Record<string, unknown>): string[] {
  const findings: string[] = [];
  if (typeof result.summary === "string") findings.push(result.summary);
  if (Array.isArray(result.findings)) {
    findings.push(...result.findings.filter((f): f is string => typeof f === "string").slice(0, 10));
  }
  if (Array.isArray(result.capabilities)) {
    findings.push(`${result.capabilities.length} capabilities identified`);
  }
  if (Array.isArray(result.rules)) {
    findings.push(`${result.rules.length} business rules extracted`);
  }
  return findings;
}

function extractDecisions(result: Record<string, unknown>): Array<{ decision: string; rationale: string }> {
  const decisions: Array<{ decision: string; rationale: string }> = [];
  if (typeof result.architecture === "string") {
    decisions.push({ decision: "Architecture", rationale: result.architecture });
  }
  if (typeof result.targetStack === "string") {
    decisions.push({ decision: "Target stack", rationale: result.targetStack });
  }
  if (Array.isArray(result.decisions)) {
    for (const d of result.decisions.slice(0, 5)) {
      if (d && typeof d === "object" && "decision" in d) {
        decisions.push({ decision: String(d.decision), rationale: String(d.rationale || "") });
      }
    }
  }
  return decisions;
}

// ─── STAGE KEYWORD HELPERS ──────────────────────────────────────

const STAGE_KEYWORDS: Record<string, string[]> = {
  [PipelineStageName.SCAN]: ["legacy", "analysis", "codebase", "scanning", "file-system"],
  [PipelineStageName.DECODE]: ["legacy", "analysis", "business-rules", "intent", "cobol", "vb6"],
  [PipelineStageName.BLUEPRINT]: ["architecture", "capability-map", "business-capability", "mapping"],
  [PipelineStageName.SPEC_LOCK]: ["bdd", "gherkin", "specification", "testing", "behavior"],
  [PipelineStageName.ARCHITECT]: ["architecture", "design", "microservices", "api", "database"],
  [PipelineStageName.FORGE]: ["code-generation", "transformation", "java", "python", "typescript"],
  [PipelineStageName.SHADOW_RUN]: ["testing", "parallel-run", "validation", "comparison"],
  [PipelineStageName.EVOLVE]: ["refinement", "iteration", "improvement", "review"],
};

/**
 * Get keywords for a given stage (for skill matching).
 */
export function getStageKeywords(stageName: string): string[] {
  return STAGE_KEYWORDS[stageName] || [];
}
