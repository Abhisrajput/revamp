/**
 * Pipeline Repository — database operations for pipeline lifecycle.
 *
 * Extracted from PipelineService class methods. These are standalone functions
 * that accept an explicit DB connection (no `this.` references).
 *
 * Used by: PipelineService.executeStage, route handlers, stage orchestrators.
 */

import { db, type DbConnection } from "@/db/index.js";
import { pipelineRuns, approvalGates, stageArtifacts, llmUsage, projects } from "@/db/schema.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import type { StageRunResult, StageOutput, UserFeedback } from "@revamp/core-engine";
import { getStageOrder } from "@revamp/core-engine";
import { loadTieredPriorContext, generateTierSummaries } from "./context-tiering.js";
import crypto from "crypto";

// ─── Stage Progress ──────────────────────────────────────────────

/**
 * Atomic update of stage progress in the pipeline_runs JSONB column.
 * Uses jsonb_set to avoid read-modify-write race conditions.
 */
export async function updateStageProgress(
  pipelineRunId: string,
  stageName: PipelineStageName,
  status: string,
  progress: number,
  options?: { conn?: DbConnection; confidenceScore?: number },
): Promise<void> {
  const conn = options?.conn ?? db;
  const now = new Date().toISOString();
  const isRunning = status === 'in_progress' || status === 'generating' || status === 'validating';
  const confidenceScore = options?.confidenceScore ?? progress;

  await conn.execute(sql`
    UPDATE ${pipelineRuns}
    SET
      current_stage = ${stageName},
      stage_progress = jsonb_set(
        COALESCE(stage_progress, '{}'::jsonb),
        ${sql.raw(`'{${stageName}}'`)},
        COALESCE(stage_progress -> ${stageName}, '{}'::jsonb) || jsonb_build_object(
          'status', ${status}::text,
          'progress', ${progress}::int,
          'confidenceScore', ${confidenceScore}::int,
          'updatedAt', ${now}::text,
          'startedAt', CASE
            WHEN ${isRunning} AND (COALESCE(stage_progress -> ${stageName} ->> 'startedAt', '') = '')
            THEN ${now}::text
            ELSE COALESCE(stage_progress -> ${stageName} ->> 'startedAt', '')
          END
        )
      ),
      updated_at = NOW()
    WHERE id = ${pipelineRunId}
  `);
}

// ─── Approval Gate ───────────────────────────────────────────────

/**
 * Create an approval gate for a stage.
 */
export async function createApprovalGate(
  pipelineRunId: string,
  stageName: PipelineStageName,
  requiredRole: string,
  conn: DbConnection = db,
): Promise<void> {
  await conn.insert(approvalGates).values({
    id: crypto.randomUUID(),
    pipeline_run_id: pipelineRunId,
    stage_name: stageName,
    required_role: requiredRole,
    status: "pending",
  });
}

// ─── Store Stage Output ──────────────────────────────────────────

/**
 * Persist stage output + validation as artifacts in a single transaction.
 * Also triggers async tier summary generation for the OpenViking context pattern.
 */
export async function storeStageOutput(
  pipelineRunId: string,
  stageName: PipelineStageName,
  result: StageRunResult,
): Promise<void> {
  const artifactId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(stageArtifacts).values({
      id: artifactId,
      pipeline_run_id: pipelineRunId,
      stage_name: stageName,
      artifact_type: "stage_output",
      storage_path: `pipeline/${pipelineRunId}/${stageName}/output.md`,
      file_size: Buffer.byteLength(result.output, "utf-8"),
      metadata: {
        content: result.output,
        validation: result.validation ? {
          passed: result.validation.passed,
          confidenceScore: result.validation.confidenceScore,
          issueCount: result.validation.issues.length,
        } : null,
        refinementCount: result.refinementCount,
        duration: result.duration,
      },
    });

    if (result.validation) {
      await tx.insert(stageArtifacts).values({
        id: crypto.randomUUID(),
        pipeline_run_id: pipelineRunId,
        stage_name: stageName,
        artifact_type: "validation_result",
        storage_path: `pipeline/${pipelineRunId}/${stageName}/validation.json`,
        file_size: 0,
        metadata: {
          passed: result.validation.passed,
          confidenceScore: result.validation.confidenceScore,
          deterministicResults: result.validation.deterministicResults.map((r: any) => ({
            name: r.name, score: r.score, status: r.status, message: r.message,
          })),
          llmResults: result.validation.llmResults.map((r: any) => ({
            dimension: r.dimension, score: r.score, reasoning: r.reasoning,
          })),
          contractViolations: result.validation.contractResult.violations,
          issues: result.validation.issues,
          recommendations: result.validation.recommendations,
        },
      });
    }
  });

  // Fire-and-forget: generate L0/L1 tier summaries
  generateTierSummaries(artifactId, stageName, result.output).catch((err) => {
    console.error(`[Pipeline] tier summary generation failed for ${stageName}:`, err instanceof Error ? err.message : err);
  });
}

// ─── Load Prior Stage Outputs ────────────────────────────────────

/**
 * Load prior stage outputs with tiered context loading.
 * Uses token-budget-aware compaction for large outputs.
 */
export async function loadPriorStageOutputs(
  pipelineRunId: string,
  currentStage: PipelineStageName,
  agentId?: string,
): Promise<{ outputs: StageOutput[]; trajectoryMeta?: { tokensUsed: number; totalTokenBudget: number; trajectory: unknown[]; evolutionMemoriesLoaded: number; buildDurationMs: number } }> {
  const tokenBudget = 12000;

  try {
    const { outputs, trajectory, tokensUsed } = await loadTieredPriorContext(
      pipelineRunId, currentStage, tokenBudget, agentId,
    );
    return {
      outputs,
      trajectoryMeta: {
        tokensUsed, totalTokenBudget: tokenBudget, trajectory,
        evolutionMemoriesLoaded: 0, buildDurationMs: 0,
      },
    };
  } catch {
    // Fallback to raw loading
    const order = getStageOrder();
    const currentIdx = order.indexOf(currentStage);
    const priorStages = order.slice(0, currentIdx);
    if (priorStages.length === 0) return { outputs: [] };

    const artifacts = await db.query.stageArtifacts.findMany({
      where: and(
        eq(stageArtifacts.pipeline_run_id, pipelineRunId),
        eq(stageArtifacts.artifact_type, "stage_output"),
        inArray(stageArtifacts.stage_name, priorStages),
      ),
    });

    const artifactMap = new Map<string, typeof artifacts[0]>();
    for (const artifact of artifacts) {
      if (!artifactMap.has(artifact.stage_name)) {
        artifactMap.set(artifact.stage_name, artifact);
      }
    }

    return {
      outputs: priorStages
        .filter((stage) => artifactMap.has(stage))
        .map((stage) => {
          const artifact = artifactMap.get(stage)!;
          const metadata = artifact.metadata as Record<string, unknown>;
          return {
            stageName: stage as PipelineStageName,
            stageIndex: order.indexOf(stage),
            output: (metadata?.content as string) || "",
            completedAt: artifact.created_at?.toISOString() || new Date().toISOString(),
          };
        }),
    };
  }
}

// ─── Load User Feedback ──────────────────────────────────────────

/**
 * Load user feedback from rejected approval gates.
 */
export async function loadUserFeedback(
  pipelineRunId: string,
  stageIndex: number,
): Promise<UserFeedback[]> {
  const gates = await db.query.approvalGates.findMany({
    where: and(
      eq(approvalGates.pipeline_run_id, pipelineRunId),
      eq(approvalGates.status, "rejected"),
    ),
  });

  return gates
    .filter((g) => g.approval_comment)
    .map((g) => ({
      stageIndex,
      feedback: g.approval_comment!,
      source: "approval_rejection" as const,
      timestamp: g.approved_at?.toISOString() || new Date().toISOString(),
    }));
}

// ─── Update Project Metrics ──────────────────────────────────────

/**
 * Increment project-level metrics (token usage, cost, run count).
 * Non-fatal — doesn't fail the stage if metrics update fails.
 */
export async function updateProjectMetrics(
  projectId: string,
  pipelineRunId: string,
  result: StageRunResult,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const project = await tx.query.projects.findFirst({
        where: eq(projects.id, projectId),
        columns: { metrics: true },
      });

      const currentMetrics = (project?.metrics as Record<string, unknown>) || {};

      const usageRecords = await tx.query.llmUsage.findMany({
        where: eq(llmUsage.pipeline_run_id, pipelineRunId),
      });

      let runTokens = 0;
      let runCost = 0;
      for (const record of usageRecords) {
        runTokens += record.input_tokens + record.output_tokens;
        runCost += record.cost;
      }

      const updatedMetrics: Record<string, unknown> = {
        ...currentMetrics,
        total_pipeline_runs: ((currentMetrics.total_pipeline_runs as number) || 0) + 1,
        total_tokens: ((currentMetrics.total_tokens as number) || 0) + runTokens,
        total_cost_cents: ((currentMetrics.total_cost_cents as number) || 0) + runCost,
        last_run_duration_ms: result.duration,
        last_run_at: new Date().toISOString(),
        stages_completed: ((currentMetrics.stages_completed as number) || 0) + 1,
        total_refinements: ((currentMetrics.total_refinements as number) || 0) + result.refinementCount,
      };

      if (result.validation) {
        updatedMetrics.last_confidence_score = result.validation.confidenceScore;
        updatedMetrics.total_validation_issues =
          ((currentMetrics.total_validation_issues as number) || 0) +
          result.validation.issues.length;
      }

      await tx
        .update(projects)
        .set({ metrics: updatedMetrics, updated_at: new Date() })
        .where(eq(projects.id, projectId));
    });
  } catch (err: any) {
    console.warn(`[Pipeline] Failed to update project metrics: ${err.message}`);
  }
}
