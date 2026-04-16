/**
 * Stage Execution Repository — CRUD for the stage_executions table.
 *
 * This is the future source of truth for stage lifecycle (Phase 2).
 * During Phase 1, these functions are called as dual-writes alongside
 * the existing stage_progress JSONB updates.
 */

import { db, type DbConnection } from "@/db/index.js";
import { stageExecutions } from "@/db/schema.js";
import { eq, and, desc, sql } from "drizzle-orm";
import type { PipelineStageName } from "@revamp/shared-types/pipeline";
import crypto from "crypto";

// ─── Types ──────────────────────────────────────────────────────

export interface CreateExecutionParams {
  pipelineRunId: string;
  stageName: PipelineStageName;
  model?: string;
}

export interface CompleteExecutionParams {
  executionId: string;
  output: string;
  validation?: Record<string, unknown>;
  tokenUsage?: { input: number; output: number; cost: number };
  conn?: DbConnection;
}

export interface FailExecutionParams {
  executionId: string;
  errorMessage: string;
  conn?: DbConnection;
}

// ─── Queries ────────────────────────────────────────────────────

/**
 * Get the latest approved execution for a stage within a pipeline run.
 */
export async function getLatestApproved(
  pipelineRunId: string,
  stageName: string,
  conn: DbConnection = db,
): Promise<{ id: string; version: number; output: string | null } | null> {
  const row = await conn.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.pipeline_run_id, pipelineRunId),
      eq(stageExecutions.stage_name, stageName),
      eq(stageExecutions.approval_status, "approved"),
    ),
    orderBy: [desc(stageExecutions.version)],
    columns: { id: true, version: true, output: true },
  });
  return row ?? null;
}

/**
 * Resolve input_refs for a stage — find the latest approved execution
 * of each prior stage in the pipeline.
 */
export async function resolveInputRefs(
  pipelineRunId: string,
  priorStageNames: string[],
  conn: DbConnection = db,
): Promise<Record<string, string>> {
  if (priorStageNames.length === 0) return {};

  const refs: Record<string, string> = {};
  for (const stageName of priorStageNames) {
    const approved = await getLatestApproved(pipelineRunId, stageName, conn);
    if (approved) {
      refs[stageName] = approved.id;
    }
  }
  return refs;
}

/**
 * Get the next version number for a stage within a pipeline run.
 */
export async function getNextVersion(
  pipelineRunId: string,
  stageName: string,
  conn: DbConnection = db,
): Promise<number> {
  const result = await conn.execute(sql`
    SELECT COALESCE(MAX(version), 0) + 1 as next_version
    FROM stage_executions
    WHERE pipeline_run_id = ${pipelineRunId}
      AND stage_name = ${stageName}
  `);
  const rows = Array.isArray(result) ? result : (result as any).rows ?? [];
  return rows[0]?.next_version ?? 1;
}

// ─── Mutations ──────────────────────────────────────────────────

/**
 * Create a new stage execution (status = 'running').
 * Called when a stage starts executing.
 */
export async function createExecution(
  params: CreateExecutionParams,
  conn: DbConnection = db,
): Promise<{ id: string; version: number }> {
  const { pipelineRunId, stageName, model } = params;
  const id = crypto.randomUUID();
  const version = await getNextVersion(pipelineRunId, stageName, conn);

  // Resolve input refs from prior approved stages
  const { getStageOrder } = await import("@revamp/core-engine");
  const order = getStageOrder();
  const currentIdx = order.indexOf(stageName);
  const priorStages = currentIdx > 0 ? order.slice(0, currentIdx) : [];
  const inputRefs = await resolveInputRefs(pipelineRunId, priorStages, conn);

  await conn.insert(stageExecutions).values({
    id,
    pipeline_run_id: pipelineRunId,
    stage_name: stageName,
    version,
    status: "running",
    started_at: new Date(),
    input_refs: inputRefs,
    model: model || null,
  });

  return { id, version };
}

/**
 * Mark an execution as completed with output and validation.
 */
export async function completeExecution(
  params: CompleteExecutionParams,
): Promise<void> {
  const conn = params.conn ?? db;
  await conn.update(stageExecutions).set({
    status: "completed",
    completed_at: new Date(),
    output: params.output,
    output_length: params.output.length,
    validation: params.validation ?? null,
    token_usage: params.tokenUsage ?? null,
    updated_at: new Date(),
  }).where(eq(stageExecutions.id, params.executionId));
}

/**
 * Mark an execution as failed.
 */
export async function failExecution(
  params: FailExecutionParams,
): Promise<void> {
  const conn = params.conn ?? db;
  await conn.update(stageExecutions).set({
    status: "failed",
    completed_at: new Date(),
    error_message: params.errorMessage,
    updated_at: new Date(),
  }).where(eq(stageExecutions.id, params.executionId));
}

/**
 * Set approval status on an execution.
 */
export async function setApprovalStatus(
  pipelineRunId: string,
  stageName: string,
  status: "approved" | "rejected" | "pending",
  approvedBy?: string,
  comment?: string,
  conn: DbConnection = db,
): Promise<void> {
  // Find the latest execution for this stage
  const latest = await conn.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.pipeline_run_id, pipelineRunId),
      eq(stageExecutions.stage_name, stageName),
    ),
    orderBy: [desc(stageExecutions.version)],
    columns: { id: true },
  });
  if (!latest) return;

  await conn.update(stageExecutions).set({
    approval_status: status,
    approved_by: approvedBy || null,
    approved_at: status === "approved" || status === "rejected" ? new Date() : null,
    approval_comment: comment || null,
    status: status === "approved" ? "approved" : status === "rejected" ? "rejected" : "completed",
    updated_at: new Date(),
  }).where(eq(stageExecutions.id, latest.id));
}

/**
 * Get the latest execution for a stage (any status).
 */
export async function getLatestExecution(
  pipelineRunId: string,
  stageName: string,
  conn: DbConnection = db,
): Promise<typeof stageExecutions.$inferSelect | null> {
  const row = await conn.query.stageExecutions.findFirst({
    where: and(
      eq(stageExecutions.pipeline_run_id, pipelineRunId),
      eq(stageExecutions.stage_name, stageName),
    ),
    orderBy: [desc(stageExecutions.version)],
  });
  return row ?? null;
}
