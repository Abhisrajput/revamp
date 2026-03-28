/**
 * Retrieval Observability Service — OpenViking observable retrieval pattern.
 *
 * Records and queries how context was assembled for each stage execution,
 * enabling debugging and optimization of the tiered context strategy.
 */

import { db } from "@/db/index.js";
import { retrievalTrajectories } from "@/db/schema.js";
import { eq, and } from "drizzle-orm";
import type { RetrievalTrajectory, RetrievalStep } from "@revamp/shared-types/agent";

// ─── RECORD TRAJECTORY ──────────────────────────────────────────

interface RecordTrajectoryParams {
  pipelineRunId: string;
  stageName: string;
  agentId?: string | null;
  totalTokenBudget: number;
  tokensUsed: number;
  trajectory: RetrievalStep[];
  evolutionMemoriesLoaded: number;
  evolutionMemoryIds: string[];
  buildDurationMs: number;
}

/**
 * Record a retrieval trajectory — one row per context-build event.
 */
export async function recordRetrievalTrajectory(
  params: RecordTrajectoryParams,
): Promise<string> {
  const [inserted] = await db
    .insert(retrievalTrajectories)
    .values({
      pipeline_run_id: params.pipelineRunId,
      stage_name: params.stageName,
      agent_id: params.agentId || null,
      total_token_budget: params.totalTokenBudget,
      tokens_used: params.tokensUsed,
      trajectory: params.trajectory,
      evolution_memories_loaded: params.evolutionMemoriesLoaded,
      evolution_memory_ids: params.evolutionMemoryIds,
      build_duration_ms: params.buildDurationMs,
    })
    .returning();

  return inserted.id;
}

// ─── QUERY TRAJECTORIES ─────────────────────────────────────────

/**
 * Get all retrieval trajectories for a pipeline run.
 */
export async function getRetrievalTrajectories(
  pipelineRunId: string,
): Promise<RetrievalTrajectory[]> {
  const rows = await db.query.retrievalTrajectories.findMany({
    where: eq(retrievalTrajectories.pipeline_run_id, pipelineRunId),
    orderBy: (t, { asc }) => [asc(t.created_at)],
  });

  return rows.map((r) => ({
    id: r.id,
    pipelineRunId: r.pipeline_run_id,
    stageName: r.stage_name,
    agentId: r.agent_id,
    totalTokenBudget: r.total_token_budget,
    tokensUsed: r.tokens_used,
    trajectory: (r.trajectory as RetrievalStep[]) || [],
    evolutionMemoriesLoaded: r.evolution_memories_loaded,
    evolutionMemoryIds: (r.evolution_memory_ids as string[]) || [],
    buildDurationMs: r.build_duration_ms ?? 0,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Get retrieval trajectory for a specific stage.
 */
export async function getStageTrajectory(
  pipelineRunId: string,
  stageName: string,
): Promise<RetrievalTrajectory | null> {
  const row = await db.query.retrievalTrajectories.findFirst({
    where: and(
      eq(retrievalTrajectories.pipeline_run_id, pipelineRunId),
      eq(retrievalTrajectories.stage_name, stageName),
    ),
  });

  if (!row) return null;

  return {
    id: row.id,
    pipelineRunId: row.pipeline_run_id,
    stageName: row.stage_name,
    agentId: row.agent_id,
    totalTokenBudget: row.total_token_budget,
    tokensUsed: row.tokens_used,
    trajectory: (row.trajectory as RetrievalStep[]) || [],
    evolutionMemoriesLoaded: row.evolution_memories_loaded,
    evolutionMemoryIds: (row.evolution_memory_ids as string[]) || [],
    buildDurationMs: row.build_duration_ms ?? 0,
    createdAt: row.created_at.toISOString(),
  };
}
