/**
 * Pipeline Diagnostic Agent
 *
 * LLM-agnostic: uses whatever provider is configured in the project's
 * BYOK settings, routed through the Go LLM orchestrator.
 *
 * Approach: pre-fetch ALL diagnostic data (pipeline status, artifacts,
 * validation results, subtask data) and include it in a single prompt.
 * The LLM analyzes the data and produces a structured diagnostic report.
 * This avoids tool use, making it compatible with any LLM provider.
 */

import { db } from "@/db/index.js";
import { pipelineRuns, stageArtifacts, agentSubtasks, projects, stageExecutionLogs } from "@/db/schema.js";
import { eq, and, desc, inArray } from "drizzle-orm";
import { llmProxyService } from "./llm-proxy.js";
import type { ProjectCredentials } from "./llm-proxy.js";

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

// ─── DATA COLLECTORS ────────────────────────────────────────────

async function collectPipelineStatus(runId: string): Promise<string> {
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
  if (!run) return "Pipeline run not found";
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

async function collectAllArtifacts(runId: string): Promise<string> {
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
    null, 2,
  );
}

async function collectStageOutputs(runId: string): Promise<string> {
  const outputs = await db.query.stageArtifacts.findMany({
    where: and(
      eq(stageArtifacts.pipeline_run_id, runId),
      eq(stageArtifacts.artifact_type, "stage_output"),
    ),
    orderBy: [desc(stageArtifacts.created_at)],
  });

  const sections: string[] = [];
  for (const artifact of outputs) {
    const content = (artifact.metadata as { content?: string })?.content || "";
    const truncated = content.length > 4000
      ? content.slice(0, 4000) + `\n[... truncated, ${content.length} chars total]`
      : content;
    sections.push(`### ${artifact.stage_name}\n${truncated}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "No stage outputs found";
}

async function collectValidationResults(runId: string): Promise<string> {
  const validations = await db.query.stageArtifacts.findMany({
    where: and(
      eq(stageArtifacts.pipeline_run_id, runId),
      eq(stageArtifacts.artifact_type, "validation_result"),
    ),
    orderBy: [desc(stageArtifacts.created_at)],
  });

  if (validations.length === 0) return "No validation results found";
  return validations.map(v =>
    `### ${v.stage_name}\n${JSON.stringify(v.metadata, null, 2).slice(0, 3000)}`
  ).join("\n\n");
}

async function collectSubtaskResults(runId: string): Promise<string> {
  const subtasks = await db.query.agentSubtasks.findMany({
    where: eq(agentSubtasks.pipeline_run_id, runId),
    orderBy: [desc(agentSubtasks.created_at)],
    limit: 30,
  });

  if (subtasks.length === 0) return "No subtask data found";
  return JSON.stringify(
    subtasks.map(s => ({
      stage: s.stage_name,
      title: s.title,
      status: s.status,
      cost_cents: s.cost_cents,
      result_preview: typeof s.result === "object" ? JSON.stringify(s.result).slice(0, 300) : String(s.result).slice(0, 300),
    })),
    null, 2,
  );
}

async function collectExecutionLogs(runId: string): Promise<string> {
  // Fetch all error and warning logs, plus the most recent info logs
  const errorLogs = await db.query.stageExecutionLogs.findMany({
    where: and(
      eq(stageExecutionLogs.pipeline_run_id, runId),
      inArray(stageExecutionLogs.level, ["error", "warn"]),
    ),
    orderBy: [desc(stageExecutionLogs.created_at)],
    limit: 50,
  });

  const recentLogs = await db.query.stageExecutionLogs.findMany({
    where: eq(stageExecutionLogs.pipeline_run_id, runId),
    orderBy: [desc(stageExecutionLogs.created_at)],
    limit: 30,
  });

  // Merge and deduplicate
  const seen = new Set<string>();
  const allLogs = [...errorLogs, ...recentLogs].filter(l => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  }).sort((a, b) => (a.created_at?.getTime() || 0) - (b.created_at?.getTime() || 0));

  if (allLogs.length === 0) return "No execution logs found";

  return allLogs.map(l => {
    const detail = l.detail ? ` | ${l.detail.slice(0, 200)}` : "";
    const meta = l.metadata ? ` | ${JSON.stringify(l.metadata).slice(0, 200)}` : "";
    return `[${l.level?.toUpperCase()}] ${l.stage_name} (${l.phase || "unknown"}) — ${l.message}${detail}${meta}`;
  }).join("\n");
}

// ─── CREDENTIAL LOADER ─────────────────────────────────────────

async function loadProjectCredentials(runId: string): Promise<{ credentials?: ProjectCredentials; model?: string }> {
  const run = await db.query.pipelineRuns.findFirst({
    where: eq(pipelineRuns.id, runId),
    with: { project: true },
  });
  if (!run?.project) return {};

  const settings = (run.project as any).settings as Record<string, unknown> | null;
  const llmProviders = (
    (settings?.llmProviders as Record<string, unknown>[])
    || (settings?.llm_providers as Record<string, unknown>[])
    || []
  );
  if (llmProviders.length === 0) return {};

  const provider = (llmProviders.find((p: any) => p.is_default) || llmProviders[0]) as any;
  const ptype = provider.provider_type as string;
  const apiKeyField = provider.api_key_encrypted as string || "";
  const model = (settings?.defaultModel as string) || process.env.LLM_DEFAULT_MODEL || "";

  const creds: ProjectCredentials = { provider: ptype };

  if (ptype === "bedrock") {
    let bearerToken: string | undefined;
    let parsed: Record<string, string> | undefined;

    if (typeof apiKeyField === "string" && apiKeyField.startsWith("{")) {
      try {
        parsed = JSON.parse(apiKeyField);
        bearerToken = parsed?.bearerToken || parsed?.bearer_token || parsed?.apiKey || parsed?.api_key;
      } catch { /* */ }
    } else if (typeof apiKeyField === "string" && apiKeyField.length > 10) {
      bearerToken = apiKeyField;
    }

    if (bearerToken) {
      creds.aws_bearer_token = bearerToken;
      creds.aws_region = parsed?.region || parsed?.aws_region || "us-east-2";
    } else if (parsed) {
      creds.aws_access_key_id = parsed.accessKeyId || parsed.aws_access_key_id || "";
      creds.aws_secret_access_key = parsed.secretAccessKey || parsed.aws_secret_access_key || "";
      creds.aws_session_token = parsed.sessionToken || parsed.aws_session_token || "";
      creds.aws_region = parsed.region || parsed.aws_region || "us-east-2";
    }
  } else if (ptype === "anthropic") {
    creds.anthropic_api_key = apiKeyField;
  } else if (ptype === "openai") {
    creds.openai_api_key = apiKeyField;
  } else if (ptype === "gemini") {
    creds.gemini_api_key = apiKeyField;
  }

  return { credentials: creds, model };
}

// ─── DIAGNOSTIC AGENT ───────────────────────────────────────────

const DIAGNOSTIC_SYSTEM_PROMPT = `You are a Pipeline Diagnostic Agent for the REVAMP modernization platform.

You are given a complete dump of a pipeline run's data: status, stage outputs, validation results, and subtask execution data. Analyze everything and produce a structured diagnostic report.

ANALYSIS APPROACH:
1. Check overall pipeline status and identify which stages failed or have issues
2. READ THE EXECUTION LOGS CAREFULLY — they contain error messages, stack traces, and timing data that reveal the root cause
3. Review validation results for contract violations, low scores, or missing sections
4. Check stage outputs for truncation, empty content, or error messages
5. Check subtask data for partial failures or high-cost outliers
6. Look for patterns: credential errors (403/401), timeout errors, context length errors, empty responses
7. Synthesize a root cause and actionable fixes

OUTPUT FORMAT:
Output a single JSON object with this exact structure:
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
      "evidence": "specific data from the dump"
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

RULES:
- Be specific — cite stage names, scores, and actual content
- Don't speculate — only report what the data shows
- Focus on actionable fixes, not just diagnosis
- If everything looks healthy, say so explicitly`;

/**
 * Run the diagnostic agent against a pipeline run.
 * LLM-agnostic: uses the project's configured LLM provider via the Go orchestrator.
 */
export async function runDiagnosticAgent(runId: string): Promise<DiagnosticReport> {
  const startTime = Date.now();

  // Load project credentials to route through the correct LLM provider
  const { credentials, model } = await loadProjectCredentials(runId);
  const credSummary = credentials ? {
    provider: credentials.provider,
    hasBearerToken: !!credentials.aws_bearer_token,
    hasAccessKey: !!credentials.aws_access_key_id,
    hasAnthropicKey: !!credentials.anthropic_api_key,
    region: credentials.aws_region,
  } : "none";
  console.log(`[DiagnosticAgent] Credentials: ${JSON.stringify(credSummary)}, model: ${model || "default"}, run: ${runId}`);

  // Collect all diagnostic data in parallel
  const [pipelineStatus, artifacts, stageOutputs, validationResults, subtaskResults, executionLogs] = await Promise.all([
    collectPipelineStatus(runId),
    collectAllArtifacts(runId),
    collectStageOutputs(runId),
    collectValidationResults(runId),
    collectSubtaskResults(runId),
    collectExecutionLogs(runId),
  ]);

  // Build the diagnostic prompt with all data inline
  const userPrompt = [
    `# Pipeline Diagnostic Request`,
    `**Run ID:** ${runId}`,
    "",
    "## Pipeline Status",
    pipelineStatus,
    "",
    "## Execution Logs (errors, warnings, and recent activity)",
    executionLogs,
    "",
    "## Available Artifacts",
    artifacts,
    "",
    "## Stage Outputs",
    stageOutputs,
    "",
    "## Validation Results",
    validationResults,
    "",
    "## Subtask Execution Data",
    subtaskResults,
    "",
    "---",
    "Analyze all data above — especially the execution logs for errors — and produce the diagnostic JSON report.",
  ].join("\n");

  // Single LLM call through the Go orchestrator — works with any provider.
  // Try project credentials first; if they fail (expired/invalid), fall back to defaults.
  let response: string;
  try {
    const callFn = llmProxyService.createCallFn({
      maxTokens: 4096,
      model: model || undefined,
      credentials,
    });
    response = await callFn({
      systemPrompt: DIAGNOSTIC_SYSTEM_PROMPT,
      userPrompt,
    });
  } catch (primaryErr: any) {
    const errMsg = primaryErr?.message || String(primaryErr);
    const isAuthError = errMsg.includes("403") || errMsg.includes("401") || errMsg.includes("Authentication") || errMsg.includes("API Key");
    if (isAuthError && credentials) {
      console.warn(`[DiagnosticAgent] Project credentials failed (${errMsg}), falling back to default provider`);
      // Use "auto" model — the Go orchestrator's smart router will pick the best
      // available model from whatever global providers are configured.
      // Can't use empty string — llmProxyService falls back to LLM_DEFAULT_MODEL
      // which may be a Bedrock model ID that the default provider can't route.
      const fallbackFn = llmProxyService.createCallFn({ maxTokens: 4096, model: "auto" });
      response = await fallbackFn({
        systemPrompt: DIAGNOSTIC_SYSTEM_PROMPT,
        userPrompt,
      });
    } else {
      throw primaryErr;
    }
  }

  return parseReport(runId, response, 0, Date.now() - startTime);
}

/**
 * Parse the LLM's text response into a structured DiagnosticReport.
 */
function parseReport(runId: string, text: string, toolCallsCount: number, durationMs: number): DiagnosticReport {
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
