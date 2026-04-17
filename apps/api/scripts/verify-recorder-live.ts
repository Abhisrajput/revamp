/**
 * Live smoke test for pipeline-spend-recorder.
 *
 * Writes a test row through recordStageSpend using a dedicated sentinel
 * pipelineRunId, verifies exactly-one-row-per-table, then cleans up.
 * Consumes zero LLM tokens. Safe to run against any environment where
 * the writer has INSERT/DELETE on llm_usage + cost_events.
 *
 * Usage:
 *   pnpm --filter @revamp/api exec tsx scripts/verify-recorder-live.ts
 */

import "dotenv/config";
import { db } from "../src/db/index.js";
import { llmUsage, costEvents, projects } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { recordStageSpend } from "../src/services/pipeline-spend-recorder.js";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import crypto from "crypto";

const SENTINEL_RUN_ID   = crypto.randomUUID();
// Pick any existing project to satisfy foreign-key constraints
const firstProject      = await db.query.projects.findFirst({ columns: { id: true } });
if (!firstProject) {
  console.error("No project exists in DB — create one before running this script.");
  process.exit(1);
}
const SENTINEL_PROJECT  = firstProject.id;

console.log(`Sentinel run: ${SENTINEL_RUN_ID}`);
console.log(`Sentinel project: ${SENTINEL_PROJECT}`);
console.log("");

try {
  await recordStageSpend({
    pipelineRunId: SENTINEL_RUN_ID,
    projectId: SENTINEL_PROJECT,
    stageName: PipelineStageName.SCAN,
    stageIndex: 1,
    model: "us.anthropic.claude-sonnet-4-6-20251001-v1:0",
    provider: "bedrock",
    operation: "live-smoke-test",
    tokens: {
      inputTokens: 12_345,
      outputTokens: 6_789,
      cachedTokens: 500,
      cacheCreationTokens: 2_000,
    },
  });
  console.log("✓ recordStageSpend completed without throwing\n");

  const llmRows  = await db.query.llmUsage.findMany({ where: eq(llmUsage.pipeline_run_id,  SENTINEL_RUN_ID) });
  const costRows = await db.query.costEvents.findMany({ where: eq(costEvents.pipeline_run_id, SENTINEL_RUN_ID) });

  console.log(`llm_usage rows:   ${llmRows.length}`);
  if (llmRows.length > 0) console.log("  first:", JSON.stringify(llmRows[0], null, 2));
  console.log(`cost_events rows: ${costRows.length}`);
  if (costRows.length > 0) console.log("  first:", JSON.stringify(costRows[0], null, 2));

  const ok =
    llmRows.length  === 1 &&
    costRows.length === 1 &&
    llmRows[0].cost  > 0 &&
    costRows[0].cost_cents > 0 &&
    costRows[0].cache_creation_tokens === 2_000 &&
    costRows[0].cached_tokens === 500;

  if (ok) {
    console.log("\n✅ VERIFIED: exactly one row per table, cache fields present, cost > 0");
  } else {
    console.log("\n❌ FAILED invariants — inspect rows above");
    process.exit(2);
  }
} finally {
  // Clean up sentinel rows regardless of outcome
  await db.delete(llmUsage).where(eq(llmUsage.pipeline_run_id,  SENTINEL_RUN_ID));
  await db.delete(costEvents).where(eq(costEvents.pipeline_run_id, SENTINEL_RUN_ID));
  console.log("Cleaned up sentinel rows.");
}

process.exit(0);
