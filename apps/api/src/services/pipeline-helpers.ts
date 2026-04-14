/**
 * Pipeline helper methods — extracted from the monolithic pipeline.ts.
 *
 * Contains:
 *   - Stage progress DB operations
 *   - Approval gate management
 *   - Artifact storage
 *   - Prior stage output loading
 *   - Stage execution context builder
 */

import { db } from "@/db/index.js";
import { pipelineRuns, stageArtifacts, approvalGates, llmUsage, stageRuns } from "@/db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import type { StageOutput, UserFeedback } from "@revamp/core-engine";
import crypto from "crypto";

type DbConnection = typeof db;

// ─── Stage Output Loading ────────────────────────────────────────

/**
 * Load prior stage outputs for context building.
 * Uses tiered loading: L0 summaries for old stages, full content for recent ones.
 */
export async function loadPriorStageOutputs(
  pipelineRunId: string,
  currentStageName: PipelineStageName,
): Promise<{ outputs: StageOutput[]; trajectoryMeta: any }> {
  const outputs: StageOutput[] = [];
  let trajectoryMeta: any = null;

  try {
    // Load all stage_output artifacts for this pipeline run
    const artifacts = await db.query.stageArtifacts.findMany({
      where: and(
        eq(stageArtifacts.pipeline_run_id, pipelineRunId),
        eq(stageArtifacts.artifact_type, 'stage_output'),
      ),
      orderBy: [desc(stageArtifacts.created_at)],
    });

    // Build StageOutput array from artifacts
    const stageOrder = Object.values(PipelineStageName);
    const currentIdx = stageOrder.indexOf(currentStageName);

    for (const art of artifacts) {
      const stageIdx = stageOrder.indexOf(art.stage_name as PipelineStageName);
      if (stageIdx < 0 || stageIdx >= currentIdx) continue; // Only prior stages

      const content = (art.metadata as any)?.content || (art.metadata as any)?.output || '';
      if (!content) continue;

      outputs.push({
        stageName: art.stage_name as PipelineStageName,
        stageIndex: stageIdx,
        output: content,
        completedAt: art.created_at?.toISOString() ?? new Date().toISOString(),
      });
    }

    // Sort by stage order
    outputs.sort((a, b) => a.stageIndex - b.stageIndex);
  } catch {
    // Non-fatal
  }

  return { outputs, trajectoryMeta };
}

// ─── User Feedback Loading ───────────────────────────────────────

/**
 * Load user feedback from approval history for the given stage.
 */
export async function loadUserFeedback(
  pipelineRunId: string,
  stageIndex: number,
): Promise<UserFeedback[]> {
  const feedback: UserFeedback[] = [];

  try {
    const gates = await db.query.approvalGates.findMany({
      where: and(
        eq(approvalGates.pipeline_run_id, pipelineRunId),
      ),
    });

    for (const gate of gates) {
      if (gate.approval_comment && gate.status === 'rejected') {
        feedback.push({
          stageIndex,
          feedback: gate.approval_comment,
          source: 'approval_rejection',
          timestamp: gate.approved_at?.toISOString() ?? new Date().toISOString(),
        });
      }
    }
  } catch {
    // Non-fatal
  }

  return feedback;
}

// ─── Approval Gate ───────────────────────────────────────────────

/**
 * Create an approval gate for a stage.
 */
export async function createApprovalGate(
  pipelineRunId: string,
  stageName: string,
  requiredRole: string,
  conn: DbConnection = db,
): Promise<void> {
  // Delete any existing gate for this stage (re-run scenario)
  await conn.delete(approvalGates).where(
    and(
      eq(approvalGates.pipeline_run_id, pipelineRunId),
      eq(approvalGates.stage_name, stageName),
    ),
  );

  await conn.insert(approvalGates).values({
    id: crypto.randomUUID(),
    pipeline_run_id: pipelineRunId,
    stage_name: stageName,
    required_role: requiredRole,
    status: 'pending',
  });
}

// ─── Store Stage Output ──────────────────────────────────────────

/**
 * Persist a stage output as an artifact.
 */
export async function storeStageOutput(
  pipelineRunId: string,
  stageName: string,
  output: string,
  validation?: any,
): Promise<void> {
  // Upsert: delete old output for this stage, insert new
  await db.delete(stageArtifacts).where(
    and(
      eq(stageArtifacts.pipeline_run_id, pipelineRunId),
      eq(stageArtifacts.stage_name, stageName),
      eq(stageArtifacts.artifact_type, 'stage_output'),
    ),
  );

  await db.insert(stageArtifacts).values({
    id: crypto.randomUUID(),
    pipeline_run_id: pipelineRunId,
    stage_name: stageName,
    artifact_type: 'stage_output',
    storage_path: `pipeline/${pipelineRunId}/${stageName}/output.md`,
    file_size: output.length,
    metadata: {
      content: output,
      validation: validation ? {
        passed: validation.passed,
        confidenceScore: validation.confidenceScore,
        issueCount: validation.issues?.length ?? 0,
      } : undefined,
    },
  });

  // Store validation result as separate artifact (full details)
  if (validation) {
    await db.delete(stageArtifacts).where(
      and(
        eq(stageArtifacts.pipeline_run_id, pipelineRunId),
        eq(stageArtifacts.stage_name, stageName),
        eq(stageArtifacts.artifact_type, 'validation_result'),
      ),
    );

    await db.insert(stageArtifacts).values({
      id: crypto.randomUUID(),
      pipeline_run_id: pipelineRunId,
      stage_name: stageName,
      artifact_type: 'validation_result',
      storage_path: `pipeline/${pipelineRunId}/${stageName}/validation.json`,
      metadata: validation,
    });
  }
}
