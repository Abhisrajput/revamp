/**
 * Pipeline Operations — route-facing methods for pipeline lifecycle management.
 *
 * Called by route handlers for: stage advancement, approval/rejection,
 * run reset, failure, artifact management, section refinement, chat.
 */

import { db } from "@/db/index.js";
import { pipelineRuns, approvalGates, stageArtifacts, projects } from "@/db/schema.js";
import { NotFoundError, ValidationError } from "@/errors.js";
import { eq, and } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { getStageOrder } from "@revamp/core-engine";
import { getPipelineRun, getNextStage } from "./pipeline-config.js";
import { loadPriorStageOutputs } from "./pipeline-repository.js";
import { setApprovalStatus, getLatestExecution } from "./stage-execution-repository.js";
import { llmProxyService } from "./llm-proxy.js";
import crypto from "crypto";

// ─── Stage Advancement ───────────────────────────────────────────

export async function advanceStage(pipelineRunId: string): Promise<void> {
  const run = await getPipelineRun(pipelineRunId);
  if (!run) throw new NotFoundError("Pipeline run not found");

  const order = getStageOrder();

  // Find the latest approved stage from stage_executions
  let lastApprovedIdx = -1;
  for (let i = order.length - 1; i >= 0; i--) {
    const exec = await getLatestExecution(pipelineRunId, order[i]);
    if (exec?.approval_status === "approved") {
      lastApprovedIdx = i;
      break;
    }
  }

  const isComplete = lastApprovedIdx === order.length - 1;
  if (isComplete) {
    await db.update(pipelineRuns).set({
      status: "completed", completed_at: new Date(), updated_at: new Date(),
    }).where(eq(pipelineRuns.id, pipelineRunId));
    return;
  }

  // Stage advancement is implicit in stage_executions — just update the timestamp
  await db.update(pipelineRuns).set({
    updated_at: new Date(),
  }).where(eq(pipelineRuns.id, pipelineRunId));
}

// ─── Approval Gate ───────────────────────────────────────────────

export async function approveGate(
  pipelineRunId: string,
  stageName: PipelineStageName,
  approvedBy: string,
  comment?: string,
  force?: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    const gate = await tx.query.approvalGates.findFirst({
      where: and(
        eq(approvalGates.pipeline_run_id, pipelineRunId),
        eq(approvalGates.stage_name, stageName),
      ),
    });
    if (!gate) throw new NotFoundError("Approval gate not found");
    if (gate.status !== "pending") throw new ValidationError(`Gate already ${gate.status}`);

    // Confidence threshold check
    const run = await tx.query.pipelineRuns.findFirst({
      where: eq(pipelineRuns.id, pipelineRunId),
      columns: { project_id: true },
    });
    if (run) {
      const project = await tx.query.projects.findFirst({
        where: eq(projects.id, run.project_id),
        columns: { settings: true },
      });
      const threshold = (project?.settings as any)?.confidenceThreshold ?? 75;
      const latestExec = await getLatestExecution(pipelineRunId, stageName, tx);
      let stageScore = (latestExec?.validation as any)?.confidenceScore ?? 0;

      if (typeof stageScore !== 'number' || stageScore === 0) {
        const valArtifact = await tx.query.stageArtifacts.findFirst({
          where: and(
            eq(stageArtifacts.pipeline_run_id, pipelineRunId),
            eq(stageArtifacts.stage_name, stageName),
            eq(stageArtifacts.artifact_type, "validation_result"),
          ),
        });
        if (valArtifact?.metadata) {
          stageScore = (valArtifact.metadata as any).confidenceScore ?? stageScore;
        }
      }

      if (typeof stageScore === 'number' && stageScore > 0 && stageScore < threshold && !force) {
        throw new ValidationError(
          `Cannot approve: confidence score ${stageScore}% is below the threshold of ${threshold}%. Re-run the stage to improve the score.`
        );
      }
    }

    await tx.update(approvalGates).set({
      status: "approved", approved_by: approvedBy,
      approval_comment: comment, approved_at: new Date(),
    }).where(and(
      eq(approvalGates.pipeline_run_id, pipelineRunId),
      eq(approvalGates.stage_name, stageName),
    ));

    // Dual-write: approve the stage execution
    await setApprovalStatus(pipelineRunId, stageName, "approved", approvedBy, comment, tx);

    const nextStage = getNextStage(stageName);
    if (!nextStage) {
      await tx.update(pipelineRuns).set({
        status: "completed", completed_at: new Date(),
      }).where(eq(pipelineRuns.id, pipelineRunId));
    }
  });
}

export async function rejectGate(
  pipelineRunId: string,
  stageName: PipelineStageName,
  rejectedBy: string,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(approvalGates).set({
      status: "rejected", approved_by: rejectedBy,
      approval_comment: reason, approved_at: new Date(),
    }).where(and(
      eq(approvalGates.pipeline_run_id, pipelineRunId),
      eq(approvalGates.stage_name, stageName),
    ));

    // Dual-write: reject the stage execution
    await setApprovalStatus(pipelineRunId, stageName, "rejected", rejectedBy, reason, tx);
  });
}

// ─── Run Management ──────────────────────────────────────────────

export async function resetRunStatus(pipelineRunId: string): Promise<void> {
  await db.update(pipelineRuns).set({
    status: "running", error_message: null, completed_at: null, updated_at: new Date(),
  }).where(eq(pipelineRuns.id, pipelineRunId));
}

export async function failStage(pipelineRunId: string, errorMessage: string): Promise<void> {
  await db.update(pipelineRuns).set({
    status: "failed", error_message: errorMessage,
    completed_at: new Date(), updated_at: new Date(),
  }).where(eq(pipelineRuns.id, pipelineRunId));
}

export async function addArtifact(
  pipelineRunId: string, stageName: string, artifactType: string,
  storagePath: string, metadata?: Record<string, unknown>, fileSize?: number,
): Promise<void> {
  await db.insert(stageArtifacts).values({
    id: crypto.randomUUID(), pipeline_run_id: pipelineRunId,
    stage_name: stageName, artifact_type: artifactType,
    storage_path: storagePath, file_size: fileSize, metadata: metadata || {},
  });
}

// ─── LLM Operations ─────────────────────────────────────────────

export async function refineSection(
  pipelineRunId: string, stageName: string,
  sectionTitle: string, sectionContent: string,
  userFeedback: string, fullText: string,
): Promise<string> {
  const systemPrompt = `You are an expert technical writer helping refine a section of a modernization analysis document.
You will receive a section from a stage output along with user feedback on how to improve it.
Return ONLY the refined markdown content for that section — no explanations, no meta-commentary.
Preserve the markdown formatting, heading level, and structure.
Make the improvements the user requested while keeping the content accurate and professional.`;

  const userPrompt = `## Section to Refine
**Title:** ${sectionTitle}

**Current Content:**
${sectionContent}

---

## User Feedback
${userFeedback}

---

## Full Document Context (for reference only — do not reproduce the entire document)
${fullText.slice(0, 4000)}

---

Please provide the refined version of the "${sectionTitle}" section only.`;

  const callFn = llmProxyService.createCallFn({ maxTokens: 4096 });
  return callFn({ systemPrompt, userPrompt, cacheablePrefix: undefined, onDelta: undefined, signal: undefined });
}

export async function chat(
  pipelineRunId: string, message: string,
  history: Array<{ role: string; content: string }>,
  onDelta?: (text: string) => void, signal?: AbortSignal,
): Promise<string> {
  const run = await getPipelineRun(pipelineRunId);
  if (!run) throw new NotFoundError("Pipeline run not found");

  const order = getStageOrder();
  const { outputs: priorOutputs } = await loadPriorStageOutputs(
    pipelineRunId, order[order.length - 1] as PipelineStageName,
  );

  const contextSummary = priorOutputs
    .map((o) => `### ${o.stageName}\n${o.output}`)
    .join('\n\n---\n\n');

  const systemPrompt = `You are an AI modernization advisor helping with the ongoing evolution of a legacy-to-modern migration project.
You have access to the full pipeline context from all completed stages.
Provide actionable, specific guidance. Reference the actual codebase, architecture decisions, and BDD specs from the pipeline outputs when relevant.
Be concise but thorough.

## Pipeline Context (completed stages):
${contextSummary}`;

  const userPrompt = history.length > 0
    ? `Previous conversation:\n${history.map((m) => `${m.role}: ${m.content}`).join('\n')}\n\nUser: ${message}`
    : message;

  const callFn = llmProxyService.createCallFn({ maxTokens: 4096 });
  return callFn({ systemPrompt, userPrompt, cacheablePrefix: contextSummary, onDelta, signal });
}
