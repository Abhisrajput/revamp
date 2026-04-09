/**
 * Context Tiering Service — OpenViking L0/L1/L2 tiered context pattern.
 *
 * Replaces naive char-truncation with LLM-generated summaries at 3 fidelity levels:
 *   - L0: ~100 tokens, one-sentence summary (cheapest to load)
 *   - L1: ~2K tokens, structured key findings
 *   - L2: Full original content (fallback)
 *
 * Budget-aware loading: recent stages get L1, earlier stages get L0,
 * leftover budget upgrades the most relevant L0 → L1.
 */

import { db } from "@/db/index.js";
import { stageArtifacts, retrievalTrajectories } from "@/db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { PipelineStageName } from "@revamp/shared-types/pipeline";
import { getStageOrder, type StageOutput } from "@revamp/core-engine";
import type { RetrievalStep, ContextTier } from "@revamp/shared-types/agent";
import { llmProxyService } from "./llm-proxy.js";

/** Trigger compaction warning at 80% of token budget (Goose pattern) */
const COMPACTION_THRESHOLD = 0.80;

// ─── TOKEN ESTIMATION ────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token (standard heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── TIER SUMMARY GENERATION ─────────────────────────────────────

/**
 * Generate L0 and L1 summaries for a stage artifact using the cheapest available model.
 * Updates the artifact row in-place. Fire-and-forget safe.
 */
export async function generateTierSummaries(
  artifactId: string,
  stageName: string,
  fullContent: string,
): Promise<{ l0: string; l1: string }> {
  // Use cheapest model for summarization
  const callFn = llmProxyService.createCallFn({
    maxTokens: 1024,
    model: process.env.LLM_CHEAP_MODEL || process.env.LLM_DEFAULT_MODEL || "",
  });

  // Generate L0 — one-sentence summary
  const l0 = await callFn({
    systemPrompt:
      "You are a technical summarizer. Produce a single sentence (max 25 words) capturing the key outcome of this pipeline stage output. No preamble.",
    userPrompt: `Stage: ${stageName}\n\nContent:\n${fullContent.slice(0, 8000)}`,
  });

  // Generate L1 — structured summary
  const l1 = await callFn({
    systemPrompt: `You are a technical summarizer. Produce a structured summary of this pipeline stage output under 500 words. Use these sections:
- **Key Findings**: bullet points of what was discovered
- **Decisions Made**: any architectural or technical decisions
- **Metrics**: numbers, counts, scores mentioned
- **Risks/Issues**: problems or concerns identified
Omit empty sections. No preamble.`,
    userPrompt: `Stage: ${stageName}\n\nContent:\n${fullContent.slice(0, 16000)}`,
  });

  // Persist summaries on the artifact
  await db
    .update(stageArtifacts)
    .set({ l0_summary: l0, l1_summary: l1 })
    .where(eq(stageArtifacts.id, artifactId));

  return { l0, l1 };
}

// ─── TIERED CONTEXT LOADING ──────────────────────────────────────

interface TieredContextResult {
  outputs: StageOutput[];
  trajectory: RetrievalStep[];
  tokensUsed: number;
  /** True when progressive compaction downgraded older stages */
  compactionApplied?: boolean;
  /** Number of stages downgraded during compaction */
  stagesCompacted?: number;
}

/**
 * Load prior stage outputs using the tiered context strategy:
 *   1. Last 2 completed stages → L1 (~2K tokens each)
 *   2. Earlier stages → L0 (~100 tokens each)
 *   3. Budget leftover → upgrade most relevant L0 to L1
 *   4. Fallback: if L0/L1 NULL (pre-migration rows), truncate L2
 */
export async function loadTieredPriorContext(
  pipelineRunId: string,
  currentStage: PipelineStageName,
  tokenBudget: number,
  agentId?: string,
): Promise<TieredContextResult> {
  const startMs = Date.now();
  const order = getStageOrder();
  const currentIdx = order.indexOf(currentStage);
  const priorStages = order.slice(0, currentIdx);

  if (priorStages.length === 0) {
    return { outputs: [], trajectory: [], tokensUsed: 0 };
  }

  // Load all prior stage_output artifacts
  const artifacts = await db.query.stageArtifacts.findMany({
    where: and(
      eq(stageArtifacts.pipeline_run_id, pipelineRunId),
      eq(stageArtifacts.artifact_type, "stage_output"),
      inArray(stageArtifacts.stage_name, priorStages),
    ),
  });

  // Deduplicate: first artifact per stage
  const artifactMap = new Map<string, typeof artifacts[0]>();
  for (const artifact of artifacts) {
    if (!artifactMap.has(artifact.stage_name)) {
      artifactMap.set(artifact.stage_name, artifact);
    }
  }

  const outputs: StageOutput[] = [];
  const trajectory: RetrievalStep[] = [];
  let tokensUsed = 0;

  // Determine which stages get L1 vs L0
  const recentCount = 2;
  const orderedPrior = priorStages.filter((s) => artifactMap.has(s));

  for (let i = 0; i < orderedPrior.length; i++) {
    const stage = orderedPrior[i];
    const artifact = artifactMap.get(stage)!;
    const metadata = artifact.metadata as Record<string, unknown>;
    const fullContent = (metadata?.content as string) || "";
    const isRecent = i >= orderedPrior.length - recentCount;

    let loadedContent: string;
    let tier: ContextTier;
    let reason: RetrievalStep["reason"];

    if (isRecent && artifact.l1_summary) {
      // Recent stage with L1 available
      loadedContent = artifact.l1_summary;
      tier = "L1";
      reason = "recent_stage";
    } else if (!isRecent && artifact.l0_summary) {
      // Older stage with L0 available
      loadedContent = artifact.l0_summary;
      tier = "L0";
      reason = "high_relevance";
    } else if (isRecent && artifact.l0_summary) {
      // Recent but only L0 available — use it
      loadedContent = artifact.l0_summary;
      tier = "L0";
      reason = "recent_stage";
    } else {
      // Fallback: no summaries (pre-migration row), truncate L2
      const truncLimit = isRecent ? 4000 : 800;
      loadedContent = fullContent.slice(0, truncLimit);
      tier = "L2";
      reason = isRecent ? "recent_stage" : "high_relevance";
    }

    const contentTokens = estimateTokens(loadedContent);

    if (tokensUsed + contentTokens > tokenBudget) {
      // Over budget — try L0 if we loaded L1/L2
      if (tier !== "L0" && artifact.l0_summary) {
        loadedContent = artifact.l0_summary;
        tier = "L0";
        reason = "budget_overflow";
        const l0Tokens = estimateTokens(loadedContent);
        if (tokensUsed + l0Tokens > tokenBudget) {
          trajectory.push({
            sourceStage: stage,
            tierLoaded: "L0",
            tokensConsumed: 0,
            reason: "skipped_irrelevant",
            l0Preview: artifact.l0_summary?.slice(0, 80),
          });
          continue;
        }
        tokensUsed += l0Tokens;
      } else {
        trajectory.push({
          sourceStage: stage,
          tierLoaded: tier,
          tokensConsumed: 0,
          reason: "budget_overflow",
          l0Preview: artifact.l0_summary?.slice(0, 80),
        });
        continue;
      }
    } else {
      tokensUsed += contentTokens;
    }

    outputs.push({
      stageName: stage as PipelineStageName,
      stageIndex: order.indexOf(stage),
      output: loadedContent,
      completedAt: artifact.created_at?.toISOString() || new Date().toISOString(),
    });

    trajectory.push({
      sourceStage: stage,
      tierLoaded: tier,
      tokensConsumed: estimateTokens(loadedContent),
      reason,
      l0Preview: artifact.l0_summary?.slice(0, 80),
    });
  }

  // ── Progressive compaction (Goose pattern) ──────────────────────
  // When token usage exceeds the compaction threshold, downgrade older
  // L1 stages to L0 to reclaim budget for the most recent context.
  let compactionApplied = false;
  let stagesCompacted = 0;

  if (tokensUsed / tokenBudget > COMPACTION_THRESHOLD) {
    const pct = Math.round((tokensUsed / tokenBudget) * 100);
    console.warn(
      `[ContextTiering] Token budget at ${pct}% — compacting older stages`,
    );

    // Identify L1 stages that are NOT in the most recent 2
    const recentStages = new Set<string>(orderedPrior.slice(-recentCount));

    for (let i = 0; i < trajectory.length; i++) {
      const step = trajectory[i];
      if (step.tierLoaded !== "L1") continue;
      if (recentStages.has(step.sourceStage)) continue;
      if (step.reason === "skipped_irrelevant") continue;

      // Check if L0 summary is available for downgrade
      const artifact = artifactMap.get(step.sourceStage);
      if (!artifact?.l0_summary) continue;

      const l0Tokens = estimateTokens(artifact.l0_summary);
      const savedTokens = step.tokensConsumed - l0Tokens;
      if (savedTokens <= 0) continue;

      // Downgrade the output content to L0
      const outputIdx = outputs.findIndex(
        (o) => o.stageName === step.sourceStage,
      );
      if (outputIdx >= 0) {
        outputs[outputIdx].output = artifact.l0_summary;
      }

      // Update trajectory entry
      trajectory[i] = {
        ...step,
        tierLoaded: "L0",
        tokensConsumed: l0Tokens,
        reason: "compaction_threshold",
        compacted: true,
      };

      tokensUsed -= savedTokens;
      stagesCompacted++;
      compactionApplied = true;

      // Stop compacting once we're back under the threshold
      if (tokensUsed / tokenBudget <= COMPACTION_THRESHOLD) break;
    }
  }

  // Budget leftover: upgrade first L0 to L1 if possible
  if (tokensUsed < tokenBudget * 0.8) {
    for (let i = 0; i < trajectory.length; i++) {
      const step = trajectory[i];
      if (step.tierLoaded !== "L0" || step.reason === "skipped_irrelevant" || step.compacted) continue;

      const artifact = artifactMap.get(step.sourceStage);
      if (!artifact?.l1_summary) continue;

      const l1Tokens = estimateTokens(artifact.l1_summary);
      const extraTokens = l1Tokens - step.tokensConsumed;

      if (tokensUsed + extraTokens <= tokenBudget) {
        // Upgrade this stage from L0 → L1
        const outputIdx = outputs.findIndex((o) => o.stageName === step.sourceStage);
        if (outputIdx >= 0) {
          outputs[outputIdx].output = artifact.l1_summary;
          trajectory[i] = {
            ...step,
            tierLoaded: "L1",
            tokensConsumed: l1Tokens,
            reason: "high_relevance",
          };
          tokensUsed += extraTokens;
          break; // upgrade only one
        }
      }
    }
  }

  // Record trajectory for observability
  const durationMs = Date.now() - startMs;
  try {
    await db.insert(retrievalTrajectories).values({
      pipeline_run_id: pipelineRunId,
      stage_name: currentStage,
      agent_id: agentId || null,
      total_token_budget: tokenBudget,
      tokens_used: tokensUsed,
      trajectory,
      evolution_memories_loaded: 0,
      evolution_memory_ids: [],
      build_duration_ms: durationMs,
    });
  } catch {
    // Non-fatal: observability should never block execution
  }

  return { outputs, trajectory, tokensUsed, compactionApplied, stagesCompacted };
}
