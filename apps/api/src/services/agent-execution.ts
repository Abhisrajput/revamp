/**
 * Agent Execution Service — the bridge that injects agent identity into stage execution.
 *
 * When a pipeline stage is assigned to an agent, this service:
 *   1. Builds an agent-enhanced system prompt (persona prompt + session context)
 *   2. Wraps the LLM call function to inject agent context
 *   3. Filters tools based on agent permissions and stage requirements
 *   4. Manages agent state transitions (idle → working → idle)
 *   5. Tracks execution metrics for cost and performance attribution
 *
 * This is the "missing link" between agent assignment (agent-pipeline.ts) and
 * the core-engine stage runner (stage-runner.ts). Without this, agents get
 * assigned but their identity doesn't influence execution.
 */

import { db } from "@/db/index.js";
import { agentPersonas, agentAssignments, agentActivityLog } from "@/db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import type { AgentStageContext } from "./agent-pipeline.js";
import { getToolsForStage, type ToolDefinition } from "./agent-tools.js";
import { retryToolExecution, isToolExecutionRetryable } from "./agent-retry.js";
import type { LLMCallFn } from "@revamp/core-engine";

// ─── TYPES ──────────────────────────────────────────────────────

export interface AgentExecutionConfig {
  /** The agent stage context from matchAndAssignAgent() */
  agentCtx: AgentStageContext;
  /** The original (non-agent) LLM call function */
  baseLlmCallFn: LLMCallFn;
  /** Stage index (0-7) for tool filtering */
  stageIndex: number;
  /** Pipeline run ID */
  pipelineRunId: string;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface AgentEnhancedExecution {
  /** LLM call function wrapped with agent identity */
  llmCallFn: LLMCallFn;
  /** Tools available to this agent for this stage */
  tools: ToolDefinition[];
  /** Combined system prompt (agent persona + session context) */
  systemPromptPrefix: string;
  /** Cleanup function — call after execution to reset agent state */
  complete: () => Promise<void>;
  /** Error handler — call if execution fails to release the agent */
  fail: (error: unknown) => Promise<void>;
}

export interface ToolExecutionRequest {
  toolName: string;
  input: Record<string, unknown>;
  workspacePath: string;
}

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

// ─── AGENT STATE MANAGEMENT ─────────────────────────────────────

/**
 * Transition an agent to 'working' state.
 */
async function setAgentWorking(agentId: string): Promise<void> {
  await db
    .update(agentPersonas)
    .set({ status: "working", updated_at: new Date() })
    .where(
      and(eq(agentPersonas.id, agentId), isNull(agentPersonas.hidden_at)),
    );
}

/**
 * Transition an agent back to 'idle' state.
 */
async function setAgentIdle(agentId: string): Promise<void> {
  await db
    .update(agentPersonas)
    .set({ status: "idle", updated_at: new Date() })
    .where(
      and(eq(agentPersonas.id, agentId), isNull(agentPersonas.hidden_at)),
    );
}

/**
 * Mark an assignment as failed and release the agent.
 */
async function failAssignment(
  assignmentId: string,
  agentId: string,
  error: unknown,
): Promise<void> {
  const errMsg =
    error instanceof Error ? error.message : String(error);

  await db
    .update(agentAssignments)
    .set({
      status: "failed",
      result: { error: errMsg.slice(0, 1000) },
      completed_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(agentAssignments.id, assignmentId));

  await setAgentIdle(agentId);

  try {
    await db.insert(agentActivityLog).values({
      agent_id: agentId,
      action: "assignment_failed",
      assignment_id: assignmentId,
      details: { error: errMsg.slice(0, 500) },
    });
  } catch {
    // Non-fatal
  }
}

// ─── SYSTEM PROMPT BUILDER ──────────────────────────────────────

/**
 * Build the agent-enhanced system prompt by combining:
 *   1. The agent's persona system prompt
 *   2. Session context from prior stage executions
 *   3. Agent-specific behavioral instructions
 */
function buildAgentSystemPrompt(ctx: AgentStageContext): string {
  const parts: string[] = [];

  // Agent identity header
  parts.push(
    `You are ${ctx.agentName}, an AI agent in the REVAMP modernization platform.`,
  );

  // Persona system prompt — the core of the agent's identity
  if (ctx.systemPrompt) {
    parts.push("");
    parts.push("═══ AGENT PERSONA ═══");
    parts.push(ctx.systemPrompt);
  }

  // Session context from prior stages
  if (ctx.sessionContext) {
    parts.push("");
    parts.push("═══ PRIOR CONTEXT ═══");
    parts.push(
      "The following context was accumulated from your previous work on this pipeline run.",
      "Use it to inform your analysis — reference prior findings, build on previous decisions,",
      "and avoid repeating work that was already done.",
    );
    parts.push(ctx.sessionContext);
  }

  // Evolution memories from prior pipeline runs (OpenViking self-evolution pattern)
  if (ctx.evolutionContext) {
    parts.push("");
    parts.push("═══ ACCUMULATED KNOWLEDGE ═══");
    parts.push(
      "The following learnings were automatically extracted from your previous pipeline runs.",
      "Apply them when relevant — they represent patterns and insights you've discovered before.",
    );
    parts.push(ctx.evolutionContext);
  }

  // Behavioral instructions
  parts.push("");
  parts.push("═══ BEHAVIORAL RULES ═══");
  parts.push(
    "- Stay in character as your assigned persona throughout the interaction.",
    "- Reference specific file paths, line numbers, and code snippets — never give generic advice.",
    "- If you encounter something outside your expertise, clearly flag it for escalation.",
    "- Track your confidence level: HIGH (direct evidence), MEDIUM (inference), LOW (uncertain).",
    "- When using tools, check results before proceeding — don't assume success.",
  );

  return parts.join("\n");
}

// ─── TOOL FILTERING ─────────────────────────────────────────────

/**
 * Filter tools based on both the stage requirements and the agent's permissions.
 * An agent can only use tools that are:
 *   1. Available at this stage (read-only for analysis stages, full for FORGE/EVOLVE)
 *   2. Permitted by the agent's tool_permissions list
 */
function filterToolsForAgent(
  stageIndex: number,
  agentPermissions: string[],
): ToolDefinition[] {
  const stageTools = getToolsForStage(stageIndex);

  // If agent has no explicit permissions, they get all stage-appropriate tools
  if (!agentPermissions || agentPermissions.length === 0) {
    return stageTools;
  }

  // Map permission names to tool names
  const permissionToTools: Record<string, string[]> = {
    read_code: ["read_file", "read_file_range", "batch_read_files", "list_files"],
    write_code: ["write_file", "edit_file"],
    search_code: ["search_code"],
    file_stats: ["file_stats"],
    shell_exec: ["shell_exec"],
    lsp_hover: ["lsp_hover"],
    lsp_definitions: ["lsp_definitions"],
    lsp_references: ["lsp_references"],
    lsp_symbols: ["lsp_document_symbols"],
    lsp_diagnostics: ["lsp_diagnostics"],
  };

  const allowedToolNames = new Set<string>();
  for (const perm of agentPermissions) {
    const tools = permissionToTools[perm];
    if (tools) {
      tools.forEach((t) => allowedToolNames.add(t));
    }
  }

  return stageTools.filter((t) => allowedToolNames.has(t.name));
}

// ─── LLM CALL WRAPPER ──────────────────────────────────────────

/**
 * Wrap the base LLM call function to inject the agent's system prompt.
 *
 * The wrapper prepends the agent's persona + session context to the system prompt
 * of every LLM call, ensuring the model operates with the agent's full identity.
 */
function wrapLlmCallWithAgent(
  baseLlmCallFn: LLMCallFn,
  agentSystemPrompt: string,
): LLMCallFn {
  return async (req) => {
    // Prepend agent context to the system prompt
    const enhancedSystemPrompt = [
      agentSystemPrompt,
      "",
      "═══ STAGE TASK ═══",
      req.systemPrompt,
    ].join("\n");

    return baseLlmCallFn({
      ...req,
      systemPrompt: enhancedSystemPrompt,
      // The agent persona + session context becomes the cacheable prefix
      // since it stays constant across refinement iterations
      cacheablePrefix: agentSystemPrompt,
    });
  };
}

// ─── MAIN EXECUTION BRIDGE ──────────────────────────────────────

/**
 * Prepare agent-enhanced execution for a pipeline stage.
 *
 * This is the primary entry point. Call this with an AgentStageContext from
 * matchAndAssignAgent() to get back an enhanced LLM call function, filtered
 * tools, and lifecycle hooks (complete/fail).
 *
 * Usage:
 *   const agentExec = await prepareAgentExecution({ agentCtx, baseLlmCallFn, stageIndex, pipelineRunId });
 *   // Pass agentExec.llmCallFn to runStage() instead of the base function
 *   // After execution:
 *   await agentExec.complete();    // on success
 *   await agentExec.fail(error);   // on failure
 */
export async function prepareAgentExecution(
  config: AgentExecutionConfig,
): Promise<AgentEnhancedExecution> {
  const { agentCtx, baseLlmCallFn, stageIndex, pipelineRunId } = config;

  // Transition agent to working state
  await setAgentWorking(agentCtx.agentId);

  // Log the execution start
  try {
    await db.insert(agentActivityLog).values({
      agent_id: agentCtx.agentId,
      action: "execution_started",
      assignment_id: agentCtx.assignmentId,
      pipeline_run_id: pipelineRunId,
      details: {
        stageIndex,
        agentName: agentCtx.agentName,
        hasSessionContext: !!agentCtx.sessionContext,
      },
    });
  } catch {
    // Non-fatal
  }

  // Build the enhanced system prompt
  const systemPromptPrefix = buildAgentSystemPrompt(agentCtx);

  // Wrap the LLM call function with agent identity
  const llmCallFn = wrapLlmCallWithAgent(baseLlmCallFn, systemPromptPrefix);

  // Filter tools for this agent + stage combination
  const tools = filterToolsForAgent(stageIndex, agentCtx.toolPermissions);

  return {
    llmCallFn,
    tools,
    systemPromptPrefix,

    // Lifecycle: success — with retry to prevent stuck "working" state
    complete: async () => {
      try {
        await setAgentIdle(agentCtx.agentId);
      } catch (err) {
        console.error(`[AgentExec] Failed to set agent ${agentCtx.agentId} idle, retrying:`, err);
        try {
          await setAgentIdle(agentCtx.agentId);
        } catch (retryErr) {
          console.error(`[AgentExec] CRITICAL: Agent ${agentCtx.agentId} stuck in working state:`, retryErr);
        }
      }

      try {
        await db.insert(agentActivityLog).values({
          agent_id: agentCtx.agentId,
          action: "execution_completed",
          assignment_id: agentCtx.assignmentId,
          pipeline_run_id: pipelineRunId,
          details: { stageIndex },
        });
      } catch {
        // Non-fatal
      }
    },

    // Lifecycle: failure
    fail: async (error: unknown) => {
      await failAssignment(
        agentCtx.assignmentId,
        agentCtx.agentId,
        error,
      );
    },
  };
}

// ─── TOOL EXECUTION WITH RETRY ──────────────────────────────────

/**
 * Execute an agent tool call with retry logic.
 *
 * Wraps the tool execution sandbox with exponential backoff and jitter.
 * The actual tool sandbox execution is delegated to the caller — this
 * function handles the retry wrapper.
 */
export async function executeToolWithRetry(
  toolFn: () => Promise<ToolExecutionResult>,
  toolName: string,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  return retryToolExecution(toolFn, {
    maxRetries: 3,
    baseDelayMs: 1000,
    isRetryable: isToolExecutionRetryable,
    signal,
    onRetry: (attempt, error, delayMs) => {
      console.warn(
        `[AgentExecution] Tool "${toolName}" retry #${attempt} in ${delayMs}ms: ${
          error instanceof Error ? error.message : error
        }`,
      );
    },
  });
}

// ─── STANDALONE EXECUTION (for Go Coordinator) ──────────────────

/**
 * Execute an agent assignment that was checked out by the Go coordinator.
 *
 * This is the HTTP-triggered execution path. When the Go coordinator's
 * HeartbeatTick checks out a task, it calls the TypeScript API which
 * invokes this function to perform the actual execution.
 *
 * Returns the execution result or throws on failure.
 */
export async function executeAgentAssignment(
  assignmentId: string,
  options?: {
    signal?: AbortSignal;
    onEvent?: (event: Record<string, unknown>) => void;
  },
): Promise<{
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  tokensUsed?: number;
  costCents?: number;
}> {
  // Load the assignment with its agent persona
  const assignment = await db.query.agentAssignments.findFirst({
    where: eq(agentAssignments.id, assignmentId),
  });

  if (!assignment) {
    throw new Error(`Assignment not found: ${assignmentId}`);
  }

  if (assignment.status !== "in_progress") {
    throw new Error(
      `Assignment ${assignmentId} is not in_progress (status: ${assignment.status})`,
    );
  }

  // Load the agent persona
  const persona = await db.query.agentPersonas.findFirst({
    where: and(
      eq(agentPersonas.id, assignment.agent_id),
      isNull(agentPersonas.hidden_at),
    ),
  });

  if (!persona) {
    await failAssignment(assignmentId, assignment.agent_id, "Agent persona not found");
    throw new Error(`Agent persona not found: ${assignment.agent_id}`);
  }

  options?.onEvent?.({
    type: "agent_execution_started",
    assignmentId,
    agentId: persona.id,
    agentName: persona.name,
    stageName: assignment.stage_name,
    pipelineRunId: assignment.pipeline_run_id,
  });

  try {
    // Set agent to working
    await setAgentWorking(persona.id);

    // The actual stage execution is triggered through the pipeline service.
    // This function is a coordination point — the Go coordinator calls it,
    // and it delegates to the existing pipeline execution flow which already
    // has the agent context wired in via matchAndAssignAgent().
    //
    // For standalone execution (no active pipeline stage), we return a
    // "ready" status that the coordinator uses to track state.

    options?.onEvent?.({
      type: "agent_execution_ready",
      assignmentId,
      agentId: persona.id,
      message: "Agent execution prepared, awaiting pipeline dispatch",
    });

    return {
      success: true,
      result: {
        status: "ready",
        agentId: persona.id,
        agentName: persona.name,
        assignmentId,
        stageName: assignment.stage_name,
      },
    };
  } catch (error) {
    await failAssignment(assignmentId, persona.id, error);

    const errMsg = error instanceof Error ? error.message : String(error);
    options?.onEvent?.({
      type: "agent_execution_failed",
      assignmentId,
      agentId: persona.id,
      error: errMsg,
    });

    return {
      success: false,
      error: errMsg,
    };
  }
}

// ─── AGENT REVIEWER WRAPPER ────────────────────────────────────

/**
 * Create an agent-enhanced reviewer LLM call function.
 *
 * When an agent has an evaluatorModel configured, the reviewer step uses
 * a different model than the generator. This wrapper ensures the reviewer
 * also operates with awareness of the agent's context.
 */
export function wrapReviewerWithAgent(
  baseReviewerFn: LLMCallFn,
  agentCtx: AgentStageContext,
): LLMCallFn {
  const reviewerPrefix = [
    `You are reviewing work produced by ${agentCtx.agentName}.`,
    "Evaluate the output against the stage requirements with rigorous attention to detail.",
    "",
    agentCtx.sessionContext
      ? `Context from prior stages:\n${agentCtx.sessionContext}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return async (req) => {
    return baseReviewerFn({
      ...req,
      systemPrompt: `${reviewerPrefix}\n\n${req.systemPrompt}`,
    });
  };
}
