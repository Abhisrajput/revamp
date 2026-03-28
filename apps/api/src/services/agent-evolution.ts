/**
 * Agent Evolution Service — OpenViking self-evolution pattern.
 *
 * Automatically extracts reusable learnings from completed pipeline stages
 * into persistent memory. On subsequent runs, agents load relevant learnings
 * to improve their performance over time.
 *
 * Categories:
 *   - legacy_pattern: Patterns discovered in legacy code
 *   - error_recovery: How errors were resolved
 *   - user_preference: Inferred user/project preferences
 *   - domain_knowledge: Business domain insights
 */

import { db } from "@/db/index.js";
import { agentEvolutionMemory } from "@/db/schema.js";
import { eq, and, isNull, gte, desc, sql } from "drizzle-orm";
import type { EvolutionMemoryEntry, EvolutionCategory } from "@revamp/shared-types/agent";
import { llmProxyService } from "./llm-proxy.js";

// ─── EXTRACT LEARNINGS ───────────────────────────────────────────

interface ExtractionInput {
  agentId: string;
  pipelineRunId: string;
  stageName: string;
  stageOutput: string;
  sessionData?: Record<string, unknown> | null;
  findings?: string[];
  decisions?: Array<{ decision: string; rationale: string }>;
}

/**
 * Extract reusable learnings from a completed stage and persist them.
 * Uses cheapest model for extraction. Fire-and-forget safe.
 */
export async function extractEvolutionLearnings(
  input: ExtractionInput,
): Promise<EvolutionMemoryEntry[]> {
  const { agentId, pipelineRunId, stageName, stageOutput, findings, decisions } = input;

  const callFn = llmProxyService.createCallFn({
    maxTokens: 1024,
    model: process.env.LLM_CHEAP_MODEL || process.env.LLM_DEFAULT_MODEL || "",
  });

  const contextParts: string[] = [];
  if (findings?.length) contextParts.push(`Findings:\n${findings.join("\n")}`);
  if (decisions?.length) {
    contextParts.push(
      `Decisions:\n${decisions.map((d) => `- ${d.decision}: ${d.rationale}`).join("\n")}`,
    );
  }
  contextParts.push(`Stage output (truncated):\n${stageOutput.slice(0, 6000)}`);

  const prompt = `Analyze this completed pipeline stage and extract reusable learnings that would help an AI agent perform better on similar tasks in the future.

Stage: ${stageName}
${contextParts.join("\n\n")}

Return a JSON array of learnings. Each learning has:
- "category": one of "legacy_pattern", "error_recovery", "user_preference", "domain_knowledge"
- "summary": a concise, actionable learning (1-2 sentences)
- "confidence": 0.0-1.0 how confident this is a generalizable learning

Only extract learnings that are genuinely reusable across different pipeline runs.
Return an empty array if nothing is worth remembering.
Return ONLY valid JSON, no markdown fences.`;

  let rawResponse: string;
  try {
    rawResponse = await callFn({
      systemPrompt: "You are a learning extraction engine. Output only valid JSON arrays.",
      userPrompt: prompt,
    });
  } catch {
    return []; // LLM failure — non-fatal
  }

  // Parse the JSON response
  let parsed: Array<{ category: string; summary: string; confidence: number }>;
  try {
    // Strip markdown fences if present
    const cleaned = rawResponse.replace(/```json?\n?/g, "").replace(/```\n?/g, "").trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
  } catch {
    return []; // Parse failure — non-fatal
  }

  const validCategories = new Set<string>([
    "legacy_pattern",
    "error_recovery",
    "user_preference",
    "domain_knowledge",
  ]);

  const entries: EvolutionMemoryEntry[] = [];

  for (const item of parsed.slice(0, 5)) {
    if (!validCategories.has(item.category) || !item.summary) continue;

    const confidence = Math.max(0, Math.min(1, item.confidence || 0.8));

    try {
      const [inserted] = await db
        .insert(agentEvolutionMemory)
        .values({
          agent_id: agentId,
          category: item.category,
          summary: item.summary.slice(0, 2000),
          source_pipeline_run_id: pipelineRunId,
          source_stage: stageName,
          confidence: String(confidence),
          usage_count: 0,
        })
        .returning();

      entries.push({
        id: inserted.id,
        agentId: inserted.agent_id,
        category: inserted.category as EvolutionCategory,
        summary: inserted.summary,
        sourcePipelineRunId: inserted.source_pipeline_run_id,
        sourceStage: inserted.source_stage,
        confidence: parseFloat(inserted.confidence),
        usageCount: inserted.usage_count,
        lastUsedAt: inserted.last_used_at?.toISOString() ?? null,
        supersededBy: inserted.superseded_by,
        createdAt: inserted.created_at.toISOString(),
      });
    } catch {
      // Individual insert failure — continue
    }
  }

  return entries;
}

// ─── RETRIEVE MEMORIES ───────────────────────────────────────────

/**
 * Retrieve relevant evolution memories for an agent, filtered by keyword overlap.
 * Updates usage_count and last_used_at on retrieved memories.
 */
export async function retrieveEvolutionMemories(
  agentId: string,
  stageName: string,
  techStack: string[],
  limit: number = 5,
): Promise<EvolutionMemoryEntry[]> {
  // Query active (non-superseded) memories with reasonable confidence
  const memories = await db.query.agentEvolutionMemory.findMany({
    where: and(
      eq(agentEvolutionMemory.agent_id, agentId),
      isNull(agentEvolutionMemory.superseded_by),
      gte(agentEvolutionMemory.confidence, "0.50"),
    ),
    orderBy: [desc(agentEvolutionMemory.confidence), desc(agentEvolutionMemory.created_at)],
    limit: 50, // pre-filter pool
  });

  if (memories.length === 0) return [];

  // Filter by keyword overlap with stageName and techStack
  const keywords = new Set(
    [stageName.toLowerCase(), ...techStack.map((t) => t.toLowerCase())],
  );

  const scored = memories.map((m) => {
    const summaryLower = m.summary.toLowerCase();
    const categoryLower = m.category.toLowerCase();
    let relevance = 0;
    for (const kw of keywords) {
      if (summaryLower.includes(kw)) relevance += 2;
      if (categoryLower.includes(kw)) relevance += 1;
    }
    // Stage match bonus
    if (m.source_stage && m.source_stage.toLowerCase() === stageName.toLowerCase()) {
      relevance += 3;
    }
    return { memory: m, relevance };
  });

  // Sort by relevance (desc), then confidence (desc)
  scored.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return parseFloat(b.memory.confidence) - parseFloat(a.memory.confidence);
  });

  const selected = scored.slice(0, limit);

  // Update usage_count and last_used_at
  const selectedIds = selected.map((s) => s.memory.id);
  if (selectedIds.length > 0) {
    try {
      for (const id of selectedIds) {
        await db
          .update(agentEvolutionMemory)
          .set({
            usage_count: sql`${agentEvolutionMemory.usage_count} + 1`,
            last_used_at: new Date(),
          })
          .where(eq(agentEvolutionMemory.id, id));
      }
    } catch {
      // Non-fatal: usage tracking should never block retrieval
    }
  }

  return selected.map((s) => ({
    id: s.memory.id,
    agentId: s.memory.agent_id,
    category: s.memory.category as EvolutionCategory,
    summary: s.memory.summary,
    sourcePipelineRunId: s.memory.source_pipeline_run_id,
    sourceStage: s.memory.source_stage,
    confidence: parseFloat(s.memory.confidence),
    usageCount: s.memory.usage_count,
    lastUsedAt: s.memory.last_used_at?.toISOString() ?? null,
    supersededBy: s.memory.superseded_by,
    createdAt: s.memory.created_at.toISOString(),
  }));
}

// ─── SUPERSEDE MEMORY ────────────────────────────────────────────

/**
 * Mark an older memory as superseded by a newer one.
 */
export async function supersedeMemory(
  oldId: string,
  newId: string,
): Promise<void> {
  await db
    .update(agentEvolutionMemory)
    .set({ superseded_by: newId })
    .where(eq(agentEvolutionMemory.id, oldId));
}
