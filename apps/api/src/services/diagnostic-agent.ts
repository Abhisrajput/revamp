/**
 * SDK-experimental: Pipeline Diagnostic Agent
 *
 * Uses the Claude SDK with tool use to investigate failed/problematic
 * pipeline runs and produce a structured diagnostic report.
 *
 * This is a NET-NEW feature — it does NOT replace any existing orchestrator.
 * It's an independent investigation agent that:
 *   1. Reads pipeline run state, artifacts, and validation results
 *   2. Analyzes what went wrong (or what could be improved)
 *   3. Returns a structured report with root cause + suggested fixes
 *
 * Tools the agent can use:
 *   - get_pipeline_status(runId) — current state of all stages
 *   - get_stage_output(runId, stageName) — read stage output content
 *   - get_validation_results(runId, stageName) — read validation/contract violations
 *   - get_recent_logs(runId, limit) — read execution logs
 *   - get_subtask_results(runId, stageName) — read subtask outputs from agent execution
 */

import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { db } from "@/db/index.js";
import { pipelineRuns, stageArtifacts, agentSubtasks } from "@/db/schema.js";
import { eq, and, desc } from "drizzle-orm";

// ─── TYPES ──────────────────────────────────────────────────────

export interface DiagnosticReport {
  runId: string;
  status: "healthy" | "degraded" | "failed";
  rootCause: string;
  affectedStages: string[];
  findings: Array<{
    severity: "critical" | "major" | "minor";
    stage: string;
    issue: string;
    evidence: string;
  }>;
  suggestedFixes: Array<{
    priority: "P0" | "P1" | "P2";
    action: string;
    rationale: string;
  }>;
  nextSteps: string[];
  toolCallsCount: number;
  durationMs: number;
}

// ─── TOOL IMPLEMENTATIONS ───────────────────────────────────────

async function getPipelineStatus(runId: string): Promise<string> {
  const run = await db.query.pipelineRuns.findFirst({
    where: eq(pipelineRuns.id, runId),
    columns: {
      id: true,
      status: true,
      current_stage: true,
      stage_progress: true,
      error_message: true,
      started_at: true,
      completed_at: true,
    },
  });

  if (!run) return JSON.stringify({ error: "Pipeline run not found" });

  return JSON.stringify({
    runId: run.id,
    overallStatus: run.status,
    currentStage: run.current_stage,
    error: run.error_message,
    startedAt: run.started_at?.toISOString(),
    completedAt: run.completed_at?.toISOString(),
    stages: run.stage_progress,
  }, null, 2);
}

async function getStageOutput(runId: string, stageName: string): Promise<string> {
  const artifact = await db.query.stageArtifacts.findFirst({
    where: and(
      eq(stageArtifacts.pipeline_run_id, runId),
      eq(stageArtifacts.stage_name, stageName),
      eq(stageArtifacts.artifact_type, "stage_output"),
    ),
    orderBy: [desc(stageArtifacts.created_at)],
  });

  if (!artifact) return `No output artifact found for stage ${stageName}`;

  const content = (artifact.metadata as { content?: string })?.content || "";
  // Truncate to keep agent context manageable
  if (content.length > 8000) {
    return content.slice(0, 8000) + "\n\n[... output truncated, " + content.length + " chars total ...]";
  }
  return content;
}

async function getValidationResults(runId: string, stageName: string): Promise<string> {
  const artifact = await db.query.stageArtifacts.findFirst({
    where: and(
      eq(stageArtifacts.pipeline_run_id, runId),
      eq(stageArtifacts.stage_name, stageName),
      eq(stageArtifacts.artifact_type, "validation_result"),
    ),
    orderBy: [desc(stageArtifacts.created_at)],
  });

  if (!artifact) return `No validation results for ${stageName}`;
  return JSON.stringify(artifact.metadata, null, 2);
}

async function getSubtaskResults(runId: string, stageName: string): Promise<string> {
  const subtasks = await db.query.agentSubtasks.findMany({
    where: and(
      eq(agentSubtasks.pipeline_run_id, runId),
      eq(agentSubtasks.stage_name, stageName),
    ),
    orderBy: [desc(agentSubtasks.created_at)],
    limit: 20,
  });

  return JSON.stringify(
    subtasks.map(s => ({
      title: s.title,
      status: s.status,
      result: typeof s.result === "object" ? JSON.stringify(s.result).slice(0, 500) : s.result,
      cost_cents: s.cost_cents,
      created_at: s.created_at?.toISOString(),
    })),
    null,
    2,
  );
}

async function listAvailableArtifacts(runId: string): Promise<string> {
  const artifacts = await db.query.stageArtifacts.findMany({
    where: eq(stageArtifacts.pipeline_run_id, runId),
    orderBy: [desc(stageArtifacts.created_at)],
    limit: 50,
  });

  return JSON.stringify(
    artifacts.map(a => ({
      stage: a.stage_name,
      type: a.artifact_type,
      created_at: a.created_at?.toISOString(),
    })),
    null,
    2,
  );
}

// ─── TOOL DEFINITIONS FOR CLAUDE ────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_pipeline_status",
    description: "Get the current state of the pipeline run including all stage statuses, current stage, and any error messages.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_available_artifacts",
    description: "List all artifacts (outputs, validation results, subtask results) available for this pipeline run. Use this first to understand what data is available.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_stage_output",
    description: "Read the output content of a specific stage. Returns the markdown content (truncated to 8000 chars).",
    input_schema: {
      type: "object",
      properties: {
        stageName: {
          type: "string",
          description: "Stage name (SCAN, DECODE, BLUEPRINT, SPEC_LOCK, ARCHITECT, FORGE, SHADOW_RUN, EVOLVE)",
        },
      },
      required: ["stageName"],
    },
  },
  {
    name: "get_validation_results",
    description: "Read the validation results for a specific stage including contract violations, scores, and missing sections.",
    input_schema: {
      type: "object",
      properties: {
        stageName: {
          type: "string",
          description: "Stage name to get validation results for",
        },
      },
      required: ["stageName"],
    },
  },
  {
    name: "get_subtask_results",
    description: "Get subtask execution results for stages that use multi-agent orchestration (DECODE, SCAN). Shows which subtasks ran, their status, and cost.",
    input_schema: {
      type: "object",
      properties: {
        stageName: {
          type: "string",
          description: "Stage name to get subtask results for",
        },
      },
      required: ["stageName"],
    },
  },
];

// ─── DIAGNOSTIC AGENT ───────────────────────────────────────────

const DIAGNOSTIC_SYSTEM_PROMPT = `You are a Pipeline Diagnostic Agent for the REVAMP modernization platform.

Your job is to investigate a pipeline run and produce a structured diagnostic report. You have tools to read pipeline state, stage outputs, validation results, and subtask data.

INVESTIGATION APPROACH:
1. Start by calling list_available_artifacts and get_pipeline_status to understand what data exists
2. For any failed or problematic stage, get its validation results to find specific issues
3. If validation shows section mismatches or low scores, sample the actual stage output
4. For stages with subtasks (SCAN/DECODE), check subtask results for partial failures
5. Build a complete picture before producing the final report

REPORT STRUCTURE:
After your investigation, output a final JSON report with this exact structure:
\`\`\`json
{
  "status": "healthy" | "degraded" | "failed",
  "rootCause": "single sentence description of the core issue",
  "affectedStages": ["STAGE_NAME"],
  "findings": [
    {
      "severity": "critical" | "major" | "minor",
      "stage": "STAGE_NAME",
      "issue": "what went wrong",
      "evidence": "specific data from the investigation"
    }
  ],
  "suggestedFixes": [
    {
      "priority": "P0" | "P1" | "P2",
      "action": "concrete actionable fix",
      "rationale": "why this fix"
    }
  ],
  "nextSteps": ["specific next action 1", "specific next action 2"]
}
\`\`\`

INVESTIGATION RULES:
- Be specific — cite stage names, scores, and actual content from outputs
- Don't speculate — only report what the tools show you
- Focus on actionable fixes, not just diagnosis
- If everything looks healthy, say so explicitly
- Limit yourself to 10 tool calls maximum`;

/**
 * Build a Claude client — auto-detects whether to use Bedrock or direct Anthropic API.
 *
 * Priority:
 *   1. ANTHROPIC_API_KEY → direct Anthropic API
 *   2. AWS credentials present → Bedrock (uses your existing BYOK config)
 *   3. Throws if neither is available
 */
function buildClaudeClient(): { client: Anthropic | AnthropicBedrock; model: string; via: string } {
  const directKey = process.env.ANTHROPIC_API_KEY;
  if (directKey) {
    return {
      client: new Anthropic({ apiKey: directKey }),
      model: "claude-sonnet-4-20250514",
      via: "anthropic-direct",
    };
  }

  const awsKey = process.env.AWS_ACCESS_KEY_ID;
  const awsSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const awsToken = process.env.AWS_SESSION_TOKEN;
  const awsRegion = process.env.AWS_REGION || "us-east-1";

  if (awsKey && awsSecret) {
    return {
      client: new AnthropicBedrock({
        awsAccessKey: awsKey,
        awsSecretKey: awsSecret,
        awsSessionToken: awsToken,
        awsRegion,
      }),
      // Bedrock uses cross-region inference IDs (must match what's enabled in your account)
      model: process.env.LLM_DEFAULT_MODEL || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      via: "bedrock",
    };
  }

  throw new Error(
    "Diagnostic agent needs Claude credentials. Either:\n" +
    "  - Set ANTHROPIC_API_KEY in apps/api/.env (direct Anthropic API), OR\n" +
    "  - Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (uses your Bedrock setup)",
  );
}

/**
 * Run the diagnostic agent against a pipeline run.
 */
export async function runDiagnosticAgent(runId: string): Promise<DiagnosticReport> {
  const startTime = Date.now();
  let toolCallsCount = 0;

  const { client, model, via } = buildClaudeClient();
  console.log(`[DiagnosticAgent] Using Claude via ${via} (${model}) for run ${runId}`);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Investigate pipeline run ${runId}. Find any issues, identify root cause, and suggest fixes. Use the available tools to gather evidence before reporting.`,
    },
  ];

  // Agent loop — let Claude call tools until it's done
  for (let iteration = 0; iteration < 12; iteration++) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: DIAGNOSTIC_SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Add assistant response to conversation
    messages.push({ role: "assistant", content: response.content });

    // If no tool use, we have the final answer
    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find(b => b.type === "text") as Anthropic.TextBlock | undefined;
      const text = textBlock?.text || "";
      return parseReport(runId, text, toolCallsCount, Date.now() - startTime);
    }

    // Execute all tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      toolCallsCount++;

      let result: string;
      try {
        const input = block.input as Record<string, string>;
        switch (block.name) {
          case "get_pipeline_status":
            result = await getPipelineStatus(runId);
            break;
          case "list_available_artifacts":
            result = await listAvailableArtifacts(runId);
            break;
          case "get_stage_output":
            result = await getStageOutput(runId, input.stageName);
            break;
          case "get_validation_results":
            result = await getValidationResults(runId, input.stageName);
            break;
          case "get_subtask_results":
            result = await getSubtaskResults(runId, input.stageName);
            break;
          default:
            result = `Unknown tool: ${block.name}`;
        }
      } catch (err) {
        result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error("Diagnostic agent exceeded maximum iterations");
}

/**
 * Parse the agent's text response into a structured DiagnosticReport.
 */
function parseReport(runId: string, text: string, toolCallsCount: number, durationMs: number): DiagnosticReport {
  // Extract JSON from markdown code block or raw JSON
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      runId,
      status: "degraded",
      rootCause: "Diagnostic agent did not produce a structured report",
      affectedStages: [],
      findings: [{
        severity: "minor",
        stage: "diagnostic",
        issue: "Agent response was not parseable JSON",
        evidence: text.slice(0, 500),
      }],
      suggestedFixes: [],
      nextSteps: ["Re-run diagnostic"],
      toolCallsCount,
      durationMs,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    return {
      runId,
      status: parsed.status || "degraded",
      rootCause: parsed.rootCause || "Unknown",
      affectedStages: parsed.affectedStages || [],
      findings: parsed.findings || [],
      suggestedFixes: parsed.suggestedFixes || [],
      nextSteps: parsed.nextSteps || [],
      toolCallsCount,
      durationMs,
    };
  } catch (err) {
    return {
      runId,
      status: "degraded",
      rootCause: "Failed to parse diagnostic report JSON",
      affectedStages: [],
      findings: [{
        severity: "minor",
        stage: "diagnostic",
        issue: err instanceof Error ? err.message : String(err),
        evidence: text.slice(0, 500),
      }],
      suggestedFixes: [],
      nextSteps: ["Re-run diagnostic"],
      toolCallsCount,
      durationMs,
    };
  }
}
